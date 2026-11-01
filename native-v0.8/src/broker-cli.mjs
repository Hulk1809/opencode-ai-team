// Trusted administrator CLI; not an agent-facing RPC. No key generation or signing.
import {readFile} from 'node:fs/promises';
import {withBrokerLedger} from './broker.mjs';
const [operation,directory,keyPath,decisionPath,signaturePath,manifestPath]=process.argv.slice(2);
if(!['view','apply'].includes(operation)||!directory||!keyPath)throw Error('Usage: node broker-cli.mjs view STATE PUBLIC_KEY | apply STATE PUBLIC_KEY DECISION SIGNATURE MANIFEST');
const key=await readFile(keyPath);
await withBrokerLedger(directory,async ledger=>{
  if(operation==='apply')await ledger.apply(await readFile(decisionPath),await readFile(signaturePath),await readFile(manifestPath));
  console.log(JSON.stringify(ledger.view(),null,2));
},key);
