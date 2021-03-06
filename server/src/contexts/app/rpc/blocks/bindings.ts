import { dbStore } from '../../../../classes/adapters/mongodb/mongoDbInstance'

import { createRpcInstance } from '../../../../classes/libs/rpcInstance'
import { withContext } from '../../../../classes/logic/withContext';

import rpcGetInfoContext from '../getInfo/context'
import rpcBlocksContext from './context'
import { ContextMap } from '../../../../classes/contexts/contextMap';

import appContext from '../../../app/context'

const rpc = createRpcInstance();

const bindContexts = async (contextMap: ContextMap) => {
    const appContextStore = await contextMap.getContextStore({ id: 'APP' });
    const rpcGetInfo = await appContextStore.get({ context: rpcGetInfoContext });

    const { registeredContext: rpcBlocks, stateStore: rpcBlocksStateStore } = await appContextStore.register({
        context: rpcBlocksContext,
        storeEvents: true
    });
    const db = await dbStore.get();

    const initCollections = async () => {
        const contextVersion = await db.collection('versions').findOne({ id: rpcBlocks.id });
        if (!contextVersion) {
            await db.collection('blocks').createIndex({ height: 1 }, { unique: true });

            await db.collection('versions').insertOne({ id: rpcBlocks.id, version: 1 }); // with version we can do easy update migrations
        }

    }
    await initCollections();

    const resumeState = async () => {
        const getLastHeight = async () => {
            const blocks = await db.collection('blocks').find({}).sort({ height: -1 }).limit(1);
            if (blocks) {
                for await (const block of blocks) {
                    return block.height;
                }
            }
            return 0;
        }
        const height = await getLastHeight();

        // Initialize context with the most recent height (So we can resume at next height)
        await rpcBlocks.dispatch({
            type: rpcBlocksContext.commonLanguage.commands.Initialize, payload: {
                height
            }
        });
    }
    await resumeState();

    withContext(rpcBlocks)
        .handleQuery(rpcBlocksContext.commonLanguage.queries.GetByHeight, async (height) => {
            //@todo we can split this up into two differnet contexts (RPC:BLOCKHASH, RPC:BLOCK)
            //The current way might throw an exception on either call
            const hash = await rpc.call('getblockhash', [height]);
            const block = await rpc.call('getblock', [hash]);


            return block;
        })
        .handleStore(rpcBlocksContext.commonLanguage.storage.InsertOne, async (rpcBlock) => {
            await db.collection('blocks').insertOne(rpcBlock)
        })
        .handleStore(rpcBlocksContext.commonLanguage.storage.FindOneByHeight, async (height) => {
            return await db.collection('blocks').findOne({ height })
        })
        .handleStore(rpcBlocksContext.commonLanguage.storage.FindCount, async () => {
            // Current height will equal number of blocks. So we don't even need to query db to find number of blocks in db.
            const { height } = rpcBlocksStateStore.state;

            return height;

        })
        .handleStore(rpcBlocksContext.commonLanguage.storage.FindManyByPage, async ({ page, limit }) => {
            //@todo add caching
            const blocks = await db
                .collection('blocks')
                .find({})
                .sort({ height: -1 })
                .skip(page * limit)
                .limit(limit);

            return blocks.toArray();
        });



    rpcGetInfo
        .streamEvents({
            type: rpcGetInfoContext.commonLanguage.events.Updated,
            sessionOnly: true,
            callback: async (event) => {
                await rpcBlocks.dispatch({
                    type: rpcBlocksContext.commonLanguage.commands.SyncAtHeight,
                    payload: event.payload,
                    sequence: event.sequence
                });
            }
        });

}

export default {
    bindContexts
}