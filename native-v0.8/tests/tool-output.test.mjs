import test from 'node:test';
import assert from 'node:assert/strict';
import {redactToolOutput} from '../src/safety.mjs';

test('redaction preserves native TextPage prototype, brand and property descriptors',()=>{
  const brand=Symbol('TextPage');
  class TextPage { get kind(){return 'text';} }
  const page=Object.freeze(Object.defineProperties(new TextPage(),{
    text:{value:'password=private-value',enumerable:true},
    [brand]:{value:true},
  }));
  const broken=Object.fromEntries(Object.entries(page));assert.equal(broken instanceof TextPage,false);
  const clean=redactToolOutput({content:page,metadata:{line:1}});
  assert.ok(clean.content instanceof TextPage);assert.equal(clean.content[brand],true);
  assert.equal(clean.content.text,'password=[REDACTED]');assert.equal(clean.content.kind,'text');
  assert.equal(Object.getOwnPropertyDescriptor(clean.content,'text').writable,false);
  assert.equal(page.text,'password=private-value');
});
