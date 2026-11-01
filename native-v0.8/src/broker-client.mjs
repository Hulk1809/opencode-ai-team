import {request} from 'node:https';
// Host-injected TLS identity only. Never take keys, role or session identity from RPC payload.
export function brokerClient({host='127.0.0.1',port,servername,ca,cert,key}){
  const call=(path,input)=>new Promise((resolve,reject)=>{
    const req=request({host,port,servername,ca,cert,key,minVersion:'TLSv1.3',method:'POST',path,agent:false,headers:{'Content-Type':'application/json'}},res=>{
      let text='';res.on('data',chunk=>{text+=chunk;if(text.length>65536)res.destroy(Error('Broker response too large'));});
      res.on('error',reject);res.on('end',()=>{try{const data=JSON.parse(text);if(res.statusCode!==200)throw Error('Broker completion rejected; reconcile before retry');resolve(data.output);}catch(error){reject(error);}});
    });
    req.setTimeout(10000,()=>req.destroy(Error('Broker completion uncertain; reconcile before retry')));req.on('error',reject);req.end(JSON.stringify(input));
  });
  return {done:input=>call('/done',input),completionStatus:input=>call('/completionStatus',input),taskPolicy:input=>call('/taskPolicy',input)};
}
