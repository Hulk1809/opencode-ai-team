import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redact } from './safety.mjs';
const run=promisify(execFile);
const MAX=8*1024*1024;
const textTypes=new Set(['txt','md','diff','patch','json','csv','yaml','yml','java','ts','tsx','js','jsx','py','sql','xml','css','html','c','cpp','h','go','rs','sh','properties','toml']);
const mime={pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',zip:'application/zip',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg'};
export async function decodeFile(name,base64,declaredMime='') {
  if(typeof name!=='string'||name.length>180||/[\\/\x00-\x1f]/.test(name)||name.startsWith('.')) throw new Error('Tên file không an toàn');
  const ext=extname(name).slice(1).toLowerCase();
  if(/(?:^|[._-])(?:credentials?|private[_-]?key|id_rsa|id_ed25519)(?:[._-]|$)/i.test(name))throw Error('Tên file nhạy cảm không được phép');
  if(!textTypes.has(ext)&&!mime[ext]) throw new Error('Định dạng file chưa được phép');
  if(typeof base64!=='string'||base64.length>Math.ceil(MAX/3)*4||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('File quá lớn hoặc base64 lỗi');
  const bytes=Buffer.from(base64,'base64');
  if(!bytes.length||bytes.length>MAX) throw new Error('File phải từ 1 byte đến 8 MiB');
  const type=mime[ext]??'text/plain';
  if(declaredMime && !['application/octet-stream',type].includes(declaredMime) && !(textTypes.has(ext)&&(/^(text\/|application\/(json|yaml|x-yaml|javascript))/.test(declaredMime)))) throw new Error('MIME không khớp định dạng');
  const header=bytes.subarray(0,8).toString('hex');
  if((ext==='pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))||(['zip','docx'].includes(ext)&&!header.startsWith('504b0304'))||(ext==='png'&&header!=='89504e470d0a1a0a')||(['jpg','jpeg'].includes(ext)&&!header.startsWith('ffd8ff'))) throw new Error('Nội dung không khớp định dạng file');
  let text='',limitation='';
  if(textTypes.has(ext)) {
    text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if(text.includes('\0')) throw new Error('File text chứa dữ liệu nhị phân');
  } else if(['pdf','docx','zip'].includes(ext)) {
    const dir=await mkdtemp(join(process.env.TMPDIR??'/tmp/opencode','team-'));
    try {
      const path=join(dir,`input.${ext}`);await writeFile(path,bytes,{mode:0o600});
      const result=ext==='pdf' ? await run('pdftotext',['-enc','UTF-8',path,'-'],{timeout:15000,maxBuffer:2*1024*1024}) : await run('python3',[fileURLToPath(new URL('./documents.py',import.meta.url)),path,ext],{timeout:15000,maxBuffer:2*1024*1024});
      text=result.stdout;
      if(ext==='zip') limitation='ZIP chỉ trích xuất text trong vùng xử lý riêng; không chạy nội dung, binary chỉ tải xuống.';
      if(!text.trim()) limitation='Không có text trích xuất được; PDF scan cần OCR chưa hỗ trợ.';
    } finally {await rm(dir,{recursive:true,force:true});}
  } else limitation='Ảnh lưu và tải được; công cụ đọc tài liệu chưa có OCR/vision.';
  // Do not persist known credential patterns, including in downloadable text artifacts.
  if(text && (redact(text)!==text||/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|aws_(?:access_key_id|secret_access_key|session_token)\s*[:=]|-----BEGIN [^-]*PRIVATE KEY-----/i.test(text))) throw new Error('File chứa mẫu credential; hãy loại bỏ secret trước khi gửi');
  return {id:randomUUID(),name,size:bytes.length,mime:type,checksum:createHash('sha256').update(bytes).digest('hex'),base64,text:text.slice(0,500000),limitation:limitation||(text.length>500000?'Text giới hạn 500.000 ký tự.':''),createdAt:new Date().toISOString()};
}

export class TeamFiles {
  constructor(ctx){this.ctx=ctx;}
  key(directory,id){if(!/^[0-9a-f-]{36}$/.test(id)) throw new Error('File ID không hợp lệ');return `files/${encodeURIComponent(directory)}/${id}`;}
  async upload(directory,role,input){
    const visibility=input.visibility??'private';
    if(!['private','restricted','team'].includes(visibility)||typeof (input.revision??'')!=='string'||(input.revision??'').length>160||redact(input.revision??'')!==(input.revision??''))throw Error('Visibility/revision không hợp lệ');
    const file=await decodeFile(input.name,input.base64,input.mime);file.owner=role;file.visibility=visibility;file.revision=input.revision??null;file.acl=[...new Set(visibility==='team'?['owner','admin','backend','frontend','devops','qa']:['owner',role])];await this.ctx.storage.set(this.key(directory,file.id),file);return this.meta(file);
  }
  meta({base64,text,...metadata}){return {...metadata,textLength:text.length};}
  async get(directory,role,id){const f=await this.ctx.storage.get(this.key(directory,id));if(!f||!f.acl.includes(role)) throw new Error('Không có quyền đọc file');return f;}
  async read(directory,role,id,offset=0,limit=12000){if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>24000) throw new Error('Chunk không hợp lệ');const f=await this.get(directory,role,id);return {file:this.meta(f),text:redact(f.text.slice(offset,offset+limit)),offset,next:Math.min(offset+limit,f.text.length)};}
  async share(directory,role,id,recipient){const f=await this.get(directory,role,id);if(!['owner','admin',f.owner].includes(role)) throw new Error('Chỉ Owner, Admin hoặc người tạo được chia sẻ');if(!['owner','admin','frontend','backend','devops','qa','team'].includes(recipient)) throw new Error('Người nhận không hợp lệ');f.acl=[...new Set([...f.acl,...(recipient==='team'?['admin','frontend','backend','devops','qa']:[recipient])])];f.visibility=recipient==='team'?'team':f.visibility==='team'?'team':'restricted';await this.ctx.storage.set(this.key(directory,id),f);return this.meta(f);}
}
