import { RegisteredContext } from '../../../../classes/contextStore';

import { dbStore } from '../../../../classes/adapters/mongodb/mongoDbInstance'

import { rpc } from '../../../../classes/libs/rpcInstance'
import { withContext } from '../../../../classes/logic/withContext';
import { ContextStore } from '../../../../classes/contextStore';

import rpcGetInfoContext from '../getInfo/context'
import rpcBlocksContext from './context'

let timer = new Date().getTime();
let elapsed = 0
let iterations = 0

/*
const benchmark = (...log: any) => {
    const currentTime = new Date().getTime();
    iterations++;
    elapsed += currentTime - timer;
    timer = currentTime;

    const benchmarkLog = `block: ${iterations}, elapsed (seconds): ${(elapsed / 1000).toFixed(2)}, ${((iterations / elapsed) * 1000).toFixed(2)}/second`;
    //require('fs').appendFileSync('log.txt', benchmarkLog);
    console.log(benchmarkLog);
}*/

const bindContexts = async (contextStore: ContextStore) => {
    const db = await dbStore.get();

    const rpcBlocks = await contextStore.get(rpcBlocksContext);
    withContext(rpcBlocks)
        .handleQuery(rpcBlocksContext.commonLanguage.queries.GetByHeight, async (height) => {
            //@todo we can split this up into two differnet contexts (RPC:BLOCKHASH, RPC:BLOCK)
            //The current way might throw an exception on either call
            const hash = await rpc.call('getblockhash', [height]);
            const block = await rpc.call('getblock', [hash]);

            return block;
        })
        .handleStore(rpcBlocksContext.commonLanguage.storage.AddOne, async (rpcBlock) => {
            await db.collection('blocks').insertOne(rpcBlock)
        })
        .handleStore(rpcBlocksContext.commonLanguage.storage.GetBlockByHeight, async (height) => {
            return await db.collection('blocks').findOne({ height })
        });

    const rpcGetInfo = await contextStore.get(rpcGetInfoContext);
    withContext(rpcGetInfo)
        // Proxy event RPCGETINFO:UPDATED->RPCBLOCKS:INITIALIZE (no payload)
        .streamEvents({
            type: rpcGetInfoContext.commonLanguage.events.Updated, callback: async (event) => {
                await withContext(rpcBlocks).dispatch({ type: rpcBlocksContext.commonLanguage.commands.ParseGetInfo, payload: event.payload });
            }
        });

}

export default {
    bindContexts
}