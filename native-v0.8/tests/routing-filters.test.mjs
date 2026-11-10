import assert from 'node:assert/strict';
import {test} from 'node:test';
import {routingOptions} from '../src/routing-filters.mjs';

test('routing filters match provider and model name or ID without changing variants or catalog',()=>{
  const catalog=[{providerID:'one',id:'sol',name:'Solar',variants:['low','medium']},{providerID:'two',id:'flash',variants:[]}];
  const before=JSON.stringify(catalog);
  assert.deepEqual(routingOptions(catalog,'one',' SOLAR '),[
    {providerID:'one',id:'sol',variant:'low'},{providerID:'one',id:'sol',variant:'medium'}
  ]);
  assert.deepEqual(routingOptions(catalog,'','FLASH'),[{providerID:'two',id:'flash'}]);
  assert.deepEqual(routingOptions(catalog,'one','flash'),[]);
  assert.equal(routingOptions(catalog,'','').length,3);
  assert.equal(JSON.stringify(catalog),before);
});
