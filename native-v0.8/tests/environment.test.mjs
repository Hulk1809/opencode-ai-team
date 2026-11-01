import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink} from 'node:fs/promises';
import {discoverEnvironment,inspectPom} from '../src/environment.mjs';

test('discovery fingerprints multiple profiles without executing project scripts or exposing content',async()=>{
  const root=await mkdtemp('/tmp/opencode/environment-');
  for(const [name,text] of Object.entries({'pom.xml':'<project/>','package.json':'{"scripts":{"test":"exit 99"}}','uv.lock':'secret-test-content','go.mod':'module example','sample.csproj':'<Project/>','Dockerfile':'FROM ignored'}))await writeFile(`${root}/${name}`,text);
  await mkdir(`${root}/.aws`);await writeFile(`${root}/.aws/package.json`,'private');
  const report=await discoverEnvironment(root);
  assert.deepEqual(report.profiles,['dotnet','go','java-maven','node','python']);
  assert.equal(report.files.length,6);assert.equal(report.execution,'blocked');
  assert.ok(report.files.every(f=>/^[a-f0-9]{64}$/.test(f.sha256)));
  assert.ok(!JSON.stringify(report).includes('secret-test-content'));
  const before=report.files.find(f=>f.path==='pom.xml').sha256;
  await writeFile(`${root}/pom.xml`,'<project><modelVersion>4.0.0</modelVersion></project>');
  assert.notEqual((await discoverEnvironment(root)).files.find(f=>f.path==='pom.xml').sha256,before);
});
test('discovery rejects manifest symlinks and oversized inputs',async()=>{
  const root=await mkdtemp('/tmp/opencode/environment-link-');
  await symlink('/etc/passwd',`${root}/pom.xml`);
  await assert.rejects(discoverEnvironment(root),/symlink/);
  const large=await mkdtemp('/tmp/opencode/environment-large-');
  await writeFile(`${large}/package.json`,'x'.repeat(1024*1024+1));
  await assert.rejects(discoverEnvironment(large),/size/);
});
test('Java discovery resolves literal POM properties and flags effective model/dependencies unverified',async()=>{
  const pom=`<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>
    <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.4.1</version></parent>
    <properties><java.version>21</java.version><vaadin.version>24.6.0</vaadin.version><postgres.version>42.7.5</postgres.version></properties>
    <dependencies><dependency><groupId>org.postgresql</groupId><artifactId>postgresql</artifactId><version>\${postgres.version}</version></dependency>
    <dependency><groupId>org.testcontainers</groupId><artifactId>postgresql</artifactId><version>\${unresolved.version}</version></dependency></dependencies>
    <build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.13.0</version></plugin></plugins></build></project>`;
  const root=await mkdtemp('/tmp/opencode/java-plan-');await writeFile(`${root}/pom.xml`,pom);
  const report=await discoverEnvironment(root),model=report.maven[0];
  assert.deepEqual(model.javaVersions,['21']);assert.deepEqual(model.springBootVersions,['3.4.1']);assert.deepEqual(model.vaadinVersions,['24.6.0']);
  assert.equal(model.postgresql,true);assert.equal(model.testcontainers,true);assert.equal(model.dependencies[0].version,'42.7.5');
  assert.deepEqual(model.unresolved,['${unresolved.version}']);assert.equal(model.plugins[0].artifactId,'maven-compiler-plugin');
  assert.equal(report.plan.proposedRuntime.availability,'unverified in this discovery');assert.equal(report.plan.risk.dockerDaemon,true);
  assert.equal(model.effectivePomVerified,false);
});
test('POM parser fails closed on malformed/unsupported XML and keeps cyclic properties unresolved',()=>{
  for(const xml of ['<!DOCTYPE project SYSTEM "file:///etc/passwd"><project/>','<project><x></project>','<project/><project/>','<project><![CDATA[x]]></project>','<project>'])assert.throws(()=>inspectPom(xml));
  const result=inspectPom('<project><properties><java.version>${java.version}</java.version></properties></project>');
  assert.deepEqual(result.javaVersions,[]);assert.deepEqual(result.unresolved,['${java.version}']);
});
