import {open,readdir,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {redact} from './safety.mjs';
import {BUILD_IMAGE} from './build.mjs';

// ponytail: literal Maven XML only; parents/profiles/settings need offline effective-POM verification.
export function inspectPom(xml){
  if(/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(xml))throw Error('POM declarations/entities/CDATA not supported');
  const stack=[],nodes=[];let offset=0,roots=0;
  for(const token of xml.matchAll(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/g)){
    if(token.index!==offset)throw Error('Malformed POM');offset+=token[0].length;
    const text=token[0];if(text.startsWith('<!--')||text.startsWith('<?'))continue;
    if(text.startsWith('</')){
      if(!/^<\/[\w.-]+\s*>$/.test(text)||stack.at(-1)?.name!==text.slice(2,-1).trim())throw Error('Malformed POM nesting');
      stack.pop();continue;
    }
    if(text.startsWith('<')){
      const tag=/^<([\w.-]+)(?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*(\/?)>$/.exec(text);
      if(!tag||stack.length>64||nodes.length>=20000)throw Error('Unsupported or excessive POM XML');
      if(!stack.length&&++roots!==1)throw Error('Multiple POM roots');
      const node={name:tag[1],parent:stack.at(-1),text:''};nodes.push(node);
      if(!tag[2])stack.push(node);continue;
    }
    if(!stack.length&&text.trim())throw Error('Text outside POM');
    if(stack.length)stack.at(-1).text+=text;
  }
  if(offset!==xml.length||stack.length||nodes[0]?.name!=='project')throw Error('Malformed POM');
  const child=(node,name)=>nodes.find(n=>n.parent===node&&n.name===name)?.text.trim();
  const properties=Object.fromEntries(nodes.filter(n=>n.parent?.name==='properties'&&n.parent.parent===nodes[0]).map(n=>[n.name,n.text.trim()]));
  const unresolved=new Set();
  const resolve=value=>{
    if(!value)return null;
    for(let i=0;i<8&&/\$\{/.test(value);i++)value=value.replace(/\$\{([^}]+)\}/g,(all,key)=>properties[key]??all);
    if(/\$\{|&/.test(value)){unresolved.add(value);return null;}return value;
  };
  const coordinates=name=>nodes.filter(n=>n.name===name).map(n=>({groupId:resolve(child(n,'groupId')),artifactId:resolve(child(n,'artifactId')),version:resolve(child(n,'version'))}));
  const dependencies=coordinates('dependency'),plugins=coordinates('plugin'),parent=nodes.find(n=>n.name==='parent'&&n.parent===nodes[0]);
  const javaValues=['java.version','maven.compiler.release','maven.compiler.source','maven.compiler.target'].map(key=>resolve(properties[key]));
  for(const plugin of nodes.filter(n=>n.name==='plugin'&&child(n,'artifactId')==='maven-compiler-plugin')){
    const configuration=nodes.find(n=>n.parent===plugin&&n.name==='configuration');
    for(const key of ['release','source','target'])javaValues.push(resolve(child(configuration,key)));
  }
  return {javaVersions:[...new Set(javaValues.filter(Boolean))],
    springBootVersions:[...new Set([resolve(properties['spring-boot.version']),...(parent&&child(parent,'groupId')==='org.springframework.boot'?[resolve(child(parent,'version'))]:[]),...dependencies.filter(d=>d.groupId==='org.springframework.boot').map(d=>d.version)].filter(Boolean))],
    vaadinVersions:[...new Set([resolve(properties['vaadin.version']),...dependencies.filter(d=>d.groupId==='com.vaadin').map(d=>d.version)].filter(Boolean))],
    dependencies,plugins,postgresql:dependencies.some(d=>d.groupId==='org.postgresql'),testcontainers:dependencies.some(d=>d.groupId==='org.testcontainers'),
    unresolved:[...unresolved],effectivePomVerified:false,limitations:['Parent inheritance, active profiles, settings, toolchains and dependency availability not resolved; declarations are requirements, not installed versions']};
}

// ponytail: static inventory only; version/cache validation needs approved probes.
export async function discoverEnvironment(directory){
  const root=await realpath(directory),files=[],profiles=new Set(),maven=[];let count=0;
  const ignored=new Set(['.git','.env','.ssh','.aws','.gnupg','node_modules','target','build','.venv','venv','dist','bin','obj']);
  const candidate=name=>/^(pom\.xml|mvnw|gradlew|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle-wrapper\.properties|maven-wrapper\.properties|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|requirements(?:[-.\w]*)\.txt|uv\.lock|Pipfile(?:\.lock)?|go\.mod|go\.sum|global\.json|Dockerfile(?:\..*)?|(?:docker-)?compose\.ya?ml)$|\.(?:csproj|fsproj|sln)$/i.test(name);
  async function visit(path,relative='',depth=0){
    if(depth>8)throw Error('Environment discovery depth limit');
    for(const entry of await readdir(path,{withFileTypes:true})){
      if(++count>20000)throw Error('Environment discovery file limit');
      if(ignored.has(entry.name)||entry.name.startsWith('.env.'))continue;
      const name=relative?`${relative}/${entry.name}`:entry.name,target=join(path,entry.name);
      if(entry.isSymbolicLink()){if(candidate(entry.name))throw Error('Environment manifest symlink rejected');continue;}
      if(entry.isDirectory()){await visit(target,name,depth+1);continue;}
      if(!candidate(entry.name)&&!(/^\.github\/workflows\/[^/]+\.ya?ml$/.test(name)))continue;
      const file=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let bytes;
      try{const stat=await file.stat();if(!stat.isFile()||stat.size>1024*1024)throw Error('Environment manifest type/size rejected');bytes=await file.readFile();if(bytes.length>1024*1024)throw Error('Environment manifest size rejected');}finally{await file.close();}
      files.push({path:name,sha256:createHash('sha256').update(bytes).digest('hex')});
      if(entry.name==='pom.xml')maven.push({path:name,...inspectPom(bytes.toString('utf8'))});
      if(/^(pom\.xml|mvnw|maven-wrapper\.properties)$/.test(entry.name))profiles.add('java-maven');
      if(/gradle/.test(entry.name))profiles.add('java-gradle');
      if(/^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(entry.name))profiles.add('node');
      if(/^(pyproject\.toml|requirements.*\.txt|uv\.lock|Pipfile(?:\.lock)?)$/.test(entry.name))profiles.add('python');
      if(entry.name==='go.mod')profiles.add('go');
      if(/\.(?:csproj|fsproj|sln)$/.test(entry.name)||entry.name==='global.json')profiles.add('dotnet');
    }
  }
  await visit(root);files.sort((a,b)=>a.path.localeCompare(b.path));
  const javaVersions=[...new Set(maven.flatMap(p=>p.javaVersions))];
  const plan={requiredTools:maven.length?[{name:'JDK',declaredVersions:javaVersions},{name:'Maven',version:'unverified'}]:[],availableTools:[],
    missingDependencies:{status:'unverified',reason:'No offline dependency resolution executed'},
    proposedRuntime:maven.length?{image:BUILD_IMAGE,availability:'unverified in this discovery',reason:'Pinned Maven candidate; reuse if local image and Java version match, no host installation'}:null,
    requiredExecutionPermissions:['Trusted project approval for exact sessions/worktrees/cache/image and fixed offline Maven goals'],
    actionsWithinScope:['Read manifest inventory; no execution authority granted'],actionsNeedingApproval:['Code/build/QA scope activation','Any new image, network, host install, secret or production access'],
    risk:{level:'medium',reason:'Server requires Docker daemon access; Maven executes repository-controlled plugins inside container without Docker socket. Isolation reduces risk, not absolute sandbox',hostInstallation:false,repositoryWrites:'approved isolated worktrees only',dependencyChanges:'not authorized',root:false,dockerDaemon:true,production:false,credentials:false,cloudCost:false,rollback:'remove only owned stopped containers; preserve source and evidence'}};
  return JSON.parse(redact(JSON.stringify({directory:root,files,profiles:[...profiles].sort(),maven,plan,checkedAt:new Date().toISOString(),execution:'blocked',approvalRequired:true,
    impact:{risk:'low',reason:'Read-only inventory; no scripts, network, Docker, cache writes or host changes'},
    unverified:['effective runtime/framework requirements','Gradle semantic configuration','Compose/Docker build semantics','CI test commands','host PATH and permissions','local image availability','dependency/cache availability','provisioning policy','trusted Owner approval']})));
}
