import { withContext } from '../../../classes/logic/withContext';
import { createContextStore, ContextStore } from '../../../classes/contextStore';

import commonTableWidgetContext from '../../widgets/common/table/context'
import blocksWidgetBindings from '../../widgets/blocks/bindings'
import txsWidgetBindings from '../../widgets/txs/bindings'

import carverUserContext from './context'

const bindContexts = async (contextStore: ContextStore, id: string = null) => {
    // Fetch user's widget context store
    const userWidgetsContextStore = createContextStore({ id: 'USER', parent: contextStore });

    const carverUser = await contextStore.get(carverUserContext, id)

    withContext(carverUser)


        .handleQuery(carverUserContext.commonLanguage.queries.EmitToWidget, async ({ id, type, payload }) => {
            const userWidget = await userWidgetsContextStore.getById(id);
            await userWidget.dispatch({ type, payload })
        })
        .handleQuery(carverUserContext.commonLanguage.queries.GetNewWidgetContext, async ({ id, variant }) => {

            const getContext = () => {
                //@todo move this into some config outside of this context
                switch (variant) {
                    case 'blocks':
                        return { context: commonTableWidgetContext, bindings: blocksWidgetBindings };
                    case 'txs':
                        return { context: commonTableWidgetContext, bindings: txsWidgetBindings };
                }
            }

            const { context, bindings } = getContext();

            //@todo create widgets based on variant
            const newWidget = await userWidgetsContextStore.register({
                id,
                storeEvents: false, // Do not use event store for emitting (These events are projected out to frontend and do not need to be stored)
                context
            })
            await bindings.bindContexts(userWidgetsContextStore, id);

            await withContext(newWidget)
                // Proxy all events from a widget to the user (that way they can get forwarded to frontend from user context)
                .streamEvents({
                    type: '*',

                    callback: async (event) => {
                        //@todo this would be a good place for event batching (add all events into a queue and send them in batches to frontend after interval.). This would throttle number of calls to frontend (we can also send them out in chunks at at ime)
                        await withContext(carverUser)
                            .dispatch({ type: carverUserContext.commonLanguage.commands.Widgets.Emit, payload: { id, ...event } }); // event will be emitted to frontend with id (id, type, payload)
                    }
                })
                .dispatch({ type: 'INITIALIZE', payload: { id, variant } }) // 'INITIALIZE' is called on each widget it is assumed to be be handled on each context

            return {
                id
            }
        });

}

export default {
    bindContexts
}