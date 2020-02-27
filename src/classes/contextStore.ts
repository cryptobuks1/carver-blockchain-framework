const EventEmitter = require('events');

import { Context, State } from './interfaces/context'
import { Event } from './interfaces/events'
import { PermanentStore } from './interfaces/permanentStore';
import { createEventStore } from './eventStore'
import { bindContextDispatcher } from './contextDispatcher'

//@todo this should be a global permanent store (so store can be non-mongodb)
import { StateStore } from './interfaces/stateStore';
import { EventStore, ReplayEventsParams } from './interfaces/eventStore';

import { config } from '../../config'

const amqp = require('amqplib')


interface RegisterContextParams {
    context: any;
    /**
     * If set to true events eimtted in Reducer will not be stored in database.
     */
    storeEvents?: boolean;
    id: string;
}
interface CreateContextStoreOptions {
    id: string;
    version?: number;
    parent?: any;
    /**
     * If set to true start node-ipc server (for remote connections)
     **/
    serveNet?: boolean;
}
interface ContextStore {
    id: string;
    parent?: ContextStore;
    register: <EventType, TypeOfEventType>({ id, context }: RegisterContextParams, options?: any) => Promise<RegisteredContext>;
    unregister: (id: string) => Promise<void>;
    get: (context: any, id?: string) => Promise<RegisteredContext>; //@todo this should also be possible via node-ipc (just hash the context). OR we can just remove it to reduce complexity.
    getById: (id: string) => Promise<RegisteredContext>;
    getParent: (id: string) => ContextStore;
}
export interface RegisteredContext {
    context: Context;

    id: string;
    /**
     * - Reduce an event
     * - Store objects in permanent store
     * - Store new events in event store
     */
    dispatch: (event: Event) => Promise<void>;
    handleQuery: (type: string, callback: (event: Event) => Promise<any>) => void;
    handleStore: (type: string, callback: (payload: any) => Promise<any>) => void;
    query: (query: string, payload?: any) => Promise<any>;

    disconnect: () => Promise<void>;
    streamEvents: (params: ReplayEventsParams) => Promise<void>;

    /**
     *@todo Exposing state store to other contexts is dangerous. Think of a way to prevent other contexts from accessing state directly. (You should access context state via queries ONLY) 
     * Currently we're only exposing state store to get it in the same context in bindings.ts
     */
    stateStore: StateStore;
    //eventStore: EventStore; // Notice that you can't access event store directly. (use streamEvents instead)
}

const createContextStore = async ({ id, parent, serveNet }: CreateContextStoreOptions): Promise<ContextStore> => {
    const registeredContexts = new Set<RegisteredContext>();
    const registeredContextsById = new Map<string, RegisteredContext>(); // Allows quick access to a context by it's id

    const register = async <EventType, TypeOfEventType>({ id, storeEvents, context }: RegisterContextParams) => {

        //@todo during registration process ensure the commonLanguage of context does not contain any duplicate strings

        const initialState = {
            ...context.initialState
        }
        const stateStore = {
            state: initialState.isStateChain ? initialState.state : initialState
        }
        // Event emitter is shared between events and registered context. That way we can handle requests outside of event store
        const emitter = new EventEmitter();

        const eventStore = await createEventStore({ emitter, id, storeEvents });

        //@todo the binding of context dispatcher needs to be moved down (subscrieToRequest,dispatch() should not be here)


        const storeHandlers = new Map<string, ((payload: any) => Promise<any>)>();
        const queryHandlers = new Map<string, ((payload: any) => Promise<any>)>();

        const contextDispatcher = bindContextDispatcher({ emitter, storeHandlers, queryHandlers, eventStore });

        // Forward requests from emitted state to async request handler
        const handleQuery = (type: string, callback: (event: Event) => Promise<any>): void => {
            if (queryHandlers.has(type)) {
                throw commonLanguage.errors.QueryAlreadyRegistered
            }

            queryHandlers.set(type, callback)
        }

        const handleStore = (type: string, callback: (payload: any) => Promise<any>): void => {
            if (storeHandlers.has(type)) {
                throw commonLanguage.errors.StoreAlreadyRegistered
            }

            storeHandlers.set(type, callback)
        }

        const dispatchQueue = [] as any[];
        let startedDispatching = false;

        //@todo look into async.queue for this exact pattern
        const dispatchNext = async (event: Event) => {

            if (startedDispatching) {
                dispatchQueue.push(event);
                return;
            }
            startedDispatching = true;
            try {

                // Note that his can throw (Notice that state chain is built into expected emit state return)
                const reducerResults = context.reducer({ state: stateStore.state, event }) as any;

                // Notice that we store the new reducer after emitting the side effects
                const state = reducerResults.isStateChain ? reducerResults.state : reducerResults;

                const { store, emit, query, ...stateWithoutSideEffects } = state;

                // Save to permanent store / event store
                //@todo add db transaction for this storing to ensure they both have guranteed saving
                await contextDispatcher.saveToPermanentStore(store);
                await contextDispatcher.saveToEventStore(emit);

                // After successful save of both permanent/event store update the state
                stateStore.state = stateWithoutSideEffects;
                startedDispatching = false;

                // After saving / changing state emit events & queries
                await contextDispatcher.emitEvents(emit);

                //@todo this might be a good place to add timer. Dispatch an event with stats of how many queries were ran & how long they it took them to execute (For analytics and performance tuning)
                const response = await contextDispatcher.emitQueries(query);

                // Utilize the queue if there are no additional queries to emit
                if (!response) {
                    if (dispatchQueue.length > 0) {
                        return dispatchQueue.shift();
                    }
                }

                // If response is returned that means there are is a pending query. It'll be dispatch()'ed again to the context
                return response
            } catch (err) {
                console.log(`${id} exception:`);
                console.log(err);
                throw err
            }

        }



        const dispatch = async (event: Event) => {
            // Keep dispatching until there is no futher response from the context
            while (true) {
                event = await dispatchNext(event)
                if (!event) {
                    break;
                }
            }

        }

        const query = async (query: string, payload: any) => {
            if (!storeHandlers.has(query)) {
                throw commonLanguage.errors.UnhandledQuery;
            }

            const subscription = storeHandlers.get(query);
            return await subscription(payload);
        }

        const streamEvents = async (params: ReplayEventsParams) => {
            eventStore.streamEvents(params);
        }
        const disconnect = async () => {
            eventStore.unbindAllListeners();
        }

        const registeredContext = {
            id,

            context,
            dispatch,

            stateStore,
            //eventStore,

            handleQuery,
            handleStore,
            query,
            streamEvents,
            disconnect

        } as RegisteredContext
        registeredContexts.add(registeredContext);
        registeredContextsById.set(id, registeredContext);

        return registeredContext;
    };

    const unregister = async (id: string) => {
        const registeredContext = registeredContextsById.get(id);
        if (!registeredContext) {
            //@todo Should we throw an exception if a context was not found with this id or silently fail?
            return;
        }

        // Disconnect all event streams ( emitter.off() )
        await registeredContext.disconnect()

        registeredContexts.delete(registeredContext);
        registeredContextsById.delete(id);
    }

    const get = async <EventType, TypeOfEventType>(context: Context, id: string = null) => {
        for (const registeredContext of registeredContexts) {
            if (registeredContext.context === context) {
                if (!id) {
                    return registeredContext;
                }

                if (id === registeredContext.id) {
                    return registeredContext;
                }
            }
        }
    };
    const getById = async <EventType, TypeOfEventType>(id: string) => {
        return registeredContextsById.get(id);
    };

    const getParent = (id: string) => {
        let context = parent;

        while (true) {
            if (!context) {
                return null;
            }

            if (context.id === id) {
                return context;
            }

            context = context.parent;
        }
    }


    if (serveNet) {
        /*
        dispatch = push/pull
        query = request/respond
        stream events = pub/sub
        */




        const conn = await amqp.connect('amqp://localhost?heartbeat=5s');//@todo move to config
        const channel = await conn.createChannel();
        await channel.assertQueue(id, { durable: false });

        channel.consume(id, (msg: any) => {
            channel.ack(msg);

            const contents = msg.content.toString();
            console.log('from queue:', contents)
        })

        console.log('consuming:', id);


        /*
        const ipc = require('node-ipc');
        ipc.config.id = id;
        ipc.config.silent = config.ipc.silent;

        ipc.serveNet(config.ipc.networkHost, config.ipc.networkPort, () => {
            ipc.server.on('connect', () => {
                console.log('ipc client connected');
            });

            ipc.server.on('streamEvents', (params: ReplayEventsParams) => {
                console.log('ipc message:', data);
            });

            ipc.server.on('message', (data: any, socket: any) => {
                console.log('ipc message:', data);
            });
        });

        ipc.server.start();*/

        console.log('ipc server started:', id);
    }

    return {
        id,
        parent,
        register,
        unregister,
        get,
        getById,
        getParent
    };
}

const connectToContextStore = async ({ id }: CreateContextStoreOptions): Promise<ContextStore> => {

    const conn = await amqp.connect('amqp://localhost?heartbeat=5s');//@todo move to config
    const channel = await conn.createChannel();
    await channel.assertQueue(id, { durable: false })
    await channel.sendToQueue(id, Buffer.from('test message', 'utf8'))

    console.log('sent', id);

    return new Promise((resolve, reject) => {



        /*
        const ipc = require('node-ipc');
        ipc.config.id = id;
        ipc.config.silent = config.ipc.silent;

        ipc.connectToNet(id, () => {
            const ipOfId = ipc.of[id];

            const createRemoteRegisteredContext = () => {
                const get = (context: any, id?: string) => {
                    throw commonLanguage.errors.GetNotSupportedByIpc;
                }

                const getById = (id: string) => {
                    return {
                        id,
                        streamEvents: (params: ReplayEventsParams) => {

                            ipOfId.emit('streamEvents', params); //@todo this will need to have guaranteed delivery



                            console.log('should stream:', params);

                        }
                    }
                }

                return {
                    id,
                    get,
                    getById
                } as any
            }

            ipOfId.on('connect', () => {
                console.log('connected');
                ipOfId.emit('message', 'start')


                const registeredContext = createRemoteRegisteredContext();
                resolve(registeredContext);
            });

            ipOfId.on('message', (data: any) => {
                console.log('*data', data);
            });
            ipOfId.on('error', (err: any) => {
                console.log('*err', err);
            })
        })*/

    })
}

const commonLanguage = {
    errors: {
        UnhandledQuery: 'UNHANDLED_QUERY',
        QueryAlreadyRegistered: 'QUERY_ALREADY_REGISTERED',
        StoreAlreadyRegistered: 'STORE_ALREADY_REGISTERED',

        GetNotSupportedByIpc: 'ContextStore.getById() is not supported by ipc contexts. Please use contextStore.getById() instead.'
    }
}

export {
    createContextStore,
    connectToContextStore,
    ContextStore
}