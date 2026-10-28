// Capture before restart: node --import tsx tests/persistence-live.ts capture
// Verify after restart: node --import tsx tests/persistence-live.ts verify
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const token=readFileSync('.data/token','utf8').trim();
const r=await fetch('http://127.0.0.1:4310/api/state',{headers:{cookie:`team=${token}`}});
assert.equal(r.status,200);const state=await r.json();
const ids=Object.fromEntries(['projects','tasks','messages'].map(k=>[k,state[k].map((r:any)=>r.id)]));
if(process.argv[2]==='capture')writeFileSync('.data/restart-check.json',JSON.stringify(ids));
else {const old=JSON.parse(readFileSync('.data/restart-check.json','utf8'));for(const kind of Object.keys(old))for(const id of old[kind])assert.ok(ids[kind].includes(id),`${kind} ${id} lost`);}
console.log(JSON.stringify(Object.fromEntries(Object.entries(ids).map(([k,v])=>[k,(v as string[]).length]))));
