import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,realpath} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium} from '/opt/peer-runtime/playwright-core/index.mjs';

const root=await realpath(process.cwd()),check=process.argv[2];
const component=['keyboard-only check','viewport 375px check'].includes(check);
const server=createServer(async(req,res)=>{
  try{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(component&&pathname==='/'){
      res.setHeader('Content-Type','text/html');
      res.end(`<html lang="vi"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/styles.css"><main id="board"></main><script type="module">
import {renderKanban} from '/src/kanban.js';
let tasks=[{id:'probe',title:'Keyboard probe',description:'',status:'todo',priority:'medium',due:'',comments:[]}];
function draw(){renderKanban(document.querySelector('#board'),tasks,(id,status)=>{tasks=tasks.map(t=>t.id===id?{...t,status}:t);window.moved=status;draw()})}draw();window.ready=true;
</script></html>`);return;
    }
    const path=await realpath(resolve(root,'.'+(pathname==='/'?'/index.html':pathname)));
    assert(path.startsWith(root+sep)&&!path.slice(root.length).split(sep).includes('.git'));
    res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'})[extname(path)]||'application/octet-stream');
    res.end(await readFile(path));
  }catch{res.statusCode=404;res.end('Not found');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  if(check==='README commands verified'){
    const readme=await readFile(resolve(root,'README.md'),'utf8');
    assert.match(readme,/python3 -m http\.server/);assert.match(readme,/node --test/);
    assert.match(readme,/localStorage/);assert.match(readme,/1 thiết bị|một thiết bị|one device|1 thiet bi|mot thiet bi/i);
    const child=execFileSync('python3',['-c','import http.server, threading, urllib.request; s=http.server.ThreadingHTTPServer(("127.0.0.1",0),http.server.SimpleHTTPRequestHandler); threading.Thread(target=s.serve_forever,daemon=True).start(); r=urllib.request.urlopen("http://127.0.0.1:%s/" % s.server_port); assert r.status==200; print(r.status); s.shutdown(); s.server_close()'],{encoding:'utf8',timeout:10000});
    assert.equal(child.trim(),'200');
    console.log(execFileSync(process.execPath,['--test'],{encoding:'utf8',timeout:15000}));
  }
  browser=await chromium.launch({headless:true,executablePath:'/opt/peer-browsers/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:check.includes('375')?375:1280,height:900}}),errors=[];
  page.setDefaultTimeout(5000);
  page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',dialog=>dialog.accept());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  if(component){
    await page.waitForFunction(()=>window.ready===true);
    assert.equal(await page.locator('#board').getByText('Keyboard probe',{exact:true}).count(),1);
    if(check.includes('keyboard')){
      let activated=false;
      for(let i=0;i<40;i++){
        await page.keyboard.press('Tab');
        const target=await page.evaluate(()=>({tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label')}));
        if(target.tag==='BUTTON'&&target.label){await page.keyboard.press('Enter');activated=true;break;}
      }
      assert(activated,'No keyboard-accessible labelled move button');
      await page.waitForFunction(()=>['doing','done'].includes(window.moved)).catch(()=>{
        throw Error('Move button did not call onMove(id,status); renderKanban third argument must be callback function');
      });
      assert(await page.locator('[aria-live], [role="status"]').count(),'Missing live region');
    }
  }else if(check==='keyboard-only'){
    // No fill/click/selectOption: this check must exercise keyboard input exclusively.
    let focused=false;
    for(let i=0;i<40;i++){
      await page.keyboard.press('Tab');
      if(await page.locator('#f-title').evaluate(el=>el===document.activeElement)){focused=true;break;}
    }
    assert(focused,'Task title unreachable by keyboard');
    await page.keyboard.type('Keyboard task');await page.keyboard.press('Enter');
    const container=page.locator('#list, #board').first();
    await page.waitForFunction(()=>/Keyboard task/.test((document.querySelector('#list')||document.querySelector('#board')||document.body).innerText));
    await page.reload();assert.match(await container.innerText(),/Keyboard task/);
  }else if(check!=='README commands verified'){
    const container=page.locator('#list, #board').first();
    const itemSelector='#list > li, #board [data-task-id], #board article, #board .card, #board .task-card';
    await page.locator('#f-title').fill('Sandbox task');
    if(await page.locator('#f-desc').count())await page.locator('#f-desc').fill('Sandbox description');
    await page.locator('#f-submit, form button[type="submit"]').first().click();
    assert.equal(await page.locator(itemSelector).count(),1);
    const editBtn=page.locator('[data-action="edit"], button:has-text("Sửa"), button:has-text("Edit")').first();
    if(await editBtn.count()){
      await editBtn.click();
      await page.locator('#f-title').fill('Edited task');await page.locator('#f-submit, form button[type="submit"]').first().click();
    }
    if(await page.locator('[data-action="comment"] input').count()){
      await page.locator('[data-action="comment"] input').fill('Evidence comment');
      await page.locator('[data-action="comment"] button').click();
      assert.match(await container.innerText(),/Evidence comment/);
    }
    if(await page.locator('#q').count()){
      await page.locator('#q').fill('absent');assert.equal(await page.locator(itemSelector).count(),0);
      await page.locator('#q').fill(await editBtn.count()?'Edited':'Sandbox');assert.equal(await page.locator(itemSelector).count(),1);
      await page.locator('#q').fill('');
    }
    if(await page.locator('[data-action="move"]').count()){
      await page.locator('[data-action="move"]').first().selectOption('doing');
    }
    if(await page.locator('#fs').count()&&await page.locator('[data-action="move"]').count()){
      await page.locator('#fs').selectOption('todo');assert.equal(await page.locator(itemSelector).count(),0);
      await page.locator('#fs').selectOption('all');
    }
    await page.reload();assert.match(await container.innerText(),/Edited task|Sandbox task/);
    if(await page.locator('#export').count()){
      const download=page.waitForEvent('download');await page.locator('#export').click();
      const stream=await(await download).createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);
      const payload=Buffer.concat(chunks);assert(payload.length>0);
      const delBtn=page.locator('[data-action="delete"], button:has-text("Xóa"), button:has-text("Delete")').first();
      if(await delBtn.count()){
        await delBtn.click();assert.equal(await page.locator(itemSelector).count(),0);
        await page.locator('#import').setInputFiles({name:'tasks.json',mimeType:'application/json',buffer:payload});
        await page.waitForFunction(sel=>document.querySelectorAll(sel).length===1,itemSelector);
        await page.locator('#import').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{')});
        if(await page.locator('#error').count())await page.waitForFunction(()=>!document.querySelector('#error').hidden);
        assert.equal(await page.locator(itemSelector).count(),1,'Invalid import lost data');
      }
    }
  }
  if(check.includes('375'))assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal overflow at 375px');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({check,browser:await browser.version(),viewport:page.viewportSize(),assertions:'passed',sandbox:process.env.OPENCODE_WORKER_SANDBOX}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
