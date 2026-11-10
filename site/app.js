'use strict';
import { createBrowserEngine } from './engine.js';
const engine = createBrowserEngine();
const $ = (id) => document.getElementById(id);
const definitions = {
  white: {name:'去除白底',heading:'给表情留一点自由',subtitle:'轻轻拿掉白色背景，让表情出现在任何地方。',action:'开始去白底',title:'选一张你的表情',hint:'PNG、JPG、WebP 静态图片 · 素材不上传',tip:'✳ 透明区域会以棋盘格显示，下载后是真正的透明背景。',accept:'.png,.jpg,.jpeg,.webp,.bmp'},
  gif: {name:'视频转 GIF',heading:'把快乐，循环播放',subtitle:'截取视频里的精彩瞬间，变成小于 500 KB 的动态表情。',action:'制作 GIF',title:'选一段精彩瞬间',hint:'推荐 MP4 · 支持 MOV、WebM、GIF · 最大 150 MB',tip:'↻ 保留所选片段时长 · 严格检测体积 · 请保持页面在前台',accept:'.mp4,.mov,.m4v,.webm,.gif,video/*'},
  resize: {name:'图片瘦身',heading:'小一点，传得更快',subtitle:'保留画面的趣味，收起多余的体积。',action:'开始图片瘦身',title:'选一张想缩小的图片',hint:'PNG、JPG、WebP 静态图片 · 素材不上传',tip:'↙ 始终保持画面比例，小图不放大，原文件不覆盖。',accept:'.png,.jpg,.jpeg,.webp,.bmp'}
};
let state = {tool:'white',media:null,result:null,busy:false,token:null,ffmpeg:false,revision:0};
function size(bytes) { return bytes < 1000 ? `${bytes} B` : bytes < 1000000 ? `${(bytes/1000).toFixed(1)} KB` : `${(bytes/1000000).toFixed(2)} MB`; }
function notice(message='', error=false) { $('message').textContent=message; $('message').classList.toggle('error',error); $('message').hidden=!message; }
async function api(path, options={}) {
  return engine.request(path, options);
}
function compatible(media=state.media) {return media && ((state.tool==='gif') === (media.kind==='video'));}
function controls() {
  document.body.classList.toggle('busy',state.busy);
  $('process').disabled=state.busy || !compatible() || !state.token || (state.tool==='gif' && !state.ffmpeg);
  $('process-label').textContent=state.busy ? '正在处理…' : definitions[state.tool].action;
  $('sample').disabled=state.busy || !state.token;
  $('replace').disabled=state.busy;
  $('reset').disabled=state.busy;
  for(const field of document.querySelectorAll('#settings-form input, #settings-form select')) field.disabled=state.busy;
}
function clearResult() {
  state.result=null;
  $('download').hidden=true;
  $('share').hidden=true;
  $('open-result').hidden=true;
  $('result-badge').hidden=true;
  $('result-stats').hidden=true;
  $('result-pane').replaceChildren();
  const placeholder=document.createElement('div'); placeholder.className='result-placeholder';
  const star=document.createElement('span');star.textContent='✳';
  const text=document.createElement('p');text.textContent='你的下一个表情，即将在这里诞生。';
  placeholder.append(star,text);$('result-pane').append(placeholder);
  $('action-help').textContent=state.media?'设置好后，开始这次小创作。':'先放入一份素材，让灵感开工。';
}
function switchTool(tool) {
  if(state.busy) return;
  state.tool=tool; state.revision++;
  for(const button of document.querySelectorAll('[data-tool]')) {
    button.classList.toggle('active',button.dataset.tool===tool);
    if(button.dataset.tool===tool) button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
  }
  const config=definitions[tool];
  $('breadcrumb').textContent=config.name;
  $('heading').replaceChildren(document.createTextNode(config.heading));
  const period=document.createElement('span');period.textContent='。';$('heading').append(period);
  $('subtitle').textContent=config.subtitle;$('drop-title').textContent=config.title;$('drop-hint').textContent=config.hint;$('workspace-tip').textContent=config.tip;
  $('file-input').accept=config.accept;
  for(const key of ['white','gif','resize']) $(`${key}-settings`).hidden=key!==tool;
  $('sample').hidden=tool==='gif';
  if(state.media && !compatible()) {state.media=null;renderSource();}
  clearResult();notice();controls();
}
function renderMedia(url,kind,pane) {
  const element=document.createElement(kind==='video'?'video':'img');
  element.src=url;
  if(kind==='video') {element.controls=true;element.playsInline=true;element.preload='metadata';}
  else element.alt=pane==='original-pane'?'原始素材预览':'处理结果预览';
  $(pane).replaceChildren(element);
}
function renderSource() {
  const media=state.media;
  $('dropzone').hidden=!!media;$('comparison').hidden=!media;$('source-actions').hidden=!media;$('empty-label').hidden=!!media;
  if(!media) return;
  $('filename').textContent=media.name;
  $('source-details').textContent=`${media.width} × ${media.height}${media.duration ? ` · ${media.duration.toFixed(1)} 秒` : ''}`;
  $('original-size').textContent=size(media.bytes);
  renderMedia(media.url,media.kind==='video' && !media.name.toLowerCase().endsWith('.gif')?'video':'image','original-pane');
  if(media.kind==='video') {
    $('start').value='0';$('start').max=Math.max(0,media.duration-0.1).toFixed(2);
    $('duration').value=Math.min(3,media.duration).toFixed(1);
    $('clip-help').textContent=`素材共 ${media.duration.toFixed(1)} 秒，单次最多截取 15 秒。`;
  }
}
async function upload(file) {
  if(state.busy || !file) return;
  if(file.size>150*1024*1024) return notice('请选择 150 MB 以内的素材。',true);
  if(!state.token) return notice('本机服务尚未就绪，请刷新页面。',true);
  state.busy=true;controls();notice('正在读取本机素材…');
  try {
    const media=await api(`/api/upload?${new URLSearchParams({name:file.name,kind:state.tool==='gif'?'video':'image'})}`,{method:'POST',body:file,headers:{'Content-Type':'application/octet-stream'}});
    if((state.tool==='gif')!==(media.kind==='video')) {
      throw new Error(state.tool==='gif'?'请选择视频或动态 GIF；静态图片可以使用另外两个工具。':'请选择静态图片；动态图可以使用「视频转 GIF」。');
    }
    state.media=media;state.revision++;clearResult();renderSource();notice();
  } catch(error) {notice(error.message || '连接中断，请刷新页面。',true);}
  finally {state.busy=false;controls();}
}
function options() {
  if(state.tool==='white') return {scope:$('scope').value,threshold:Number($('threshold').value),softness:Number($('softness').value)};
  if(state.tool==='gif') return {start:Number($('start').value),duration:Number($('duration').value),width:Number($('gif-width').value),fps:Number($('fps').value),max_kb:Number($('gif-budget').value)};
  return {max_edge:Number($('max-edge').value),format:$('image-format').value,max_kb:Number($('image-budget').value)};
}
async function processMedia() {
  if(state.busy || !compatible() || !$('settings-form').reportValidity()) return;
  const settings=options();
  if(state.tool==='gif' && (settings.start>=state.media.duration || settings.duration<=0)) return notice('片段开始时间需要小于素材总时长。',true);
  clearResult();notice();state.busy=true;controls();$('progress-area').hidden=false;$('progress').value=0;$('progress-message').textContent='准备开工…';
  try {
    const {job_id}=await api('/api/process',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({media_id:state.media.id,operation:state.tool,options:settings})});
    let job;
    do {
      await new Promise(resolve=>setTimeout(resolve,500));
      job=await api(`/api/jobs/${job_id}`);
      $('progress').value=job.progress;$('progress-message').textContent=job.message;
    } while(job.status==='queued' || job.status==='working');
    if(job.status==='error') throw new Error(job.message);
    state.result=job.result;
    renderMedia(job.result.url,'image','result-pane');
    $('result-badge').hidden=false;$('result-stats').hidden=false;
    $('output-size').textContent=size(job.result.bytes);$('output-dimensions').textContent=`${job.result.width} × ${job.result.height}`;
    $('third-stat-label').textContent=state.tool==='gif'?'实际帧率':'体积变化';
    const ratio=1-job.result.bytes/state.media.bytes;
    $('third-stat').textContent=state.tool==='gif'?`${job.result.fps} fps`:`${ratio>=0?'−':'＋'}${Math.abs(ratio*100).toFixed(0)}%`;
    $('download').href=job.result.url;$('download').download=job.result.filename;$('download').hidden=false;
    $('open-result').href=job.result.url;$('open-result').hidden=false;
    try { $('share').hidden=!(navigator.canShare && navigator.canShare({files:[job.result.file]})); } catch { $('share').hidden=true; }
    $('action-help').textContent='手机上可下载到「文件」，也可打开结果后长按保存。';
    notice(job.result.note);
  } catch(error) {notice(error.message || '连接中断，请检查本机服务后重试。',true);}
  finally {state.busy=false;$('progress-area').hidden=true;controls();}
}
async function sample() {
  const canvas=document.createElement('canvas');canvas.width=720;canvas.height=720;
  const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,720,720);
  context.save();context.translate(360,360);context.rotate(-0.08);
  context.fillStyle='#eea24e';context.beginPath();context.moveTo(-180,-50);context.lineTo(-174,-203);context.quadraticCurveTo(-166,-225,-145,-204);context.lineTo(-65,-140);context.lineTo(70,-140);context.lineTo(149,-207);context.quadraticCurveTo(173,-222,176,-196);context.lineTo(182,-42);context.bezierCurveTo(241,130,143,207,0,210);context.bezierCurveTo(-155,211,-246,123,-180,-50);context.fill();
  context.fillStyle='#f5c08b';context.beginPath();context.moveTo(-150,-175);context.lineTo(-92,-128);context.lineTo(-152,-100);context.closePath();context.fill();context.beginPath();context.moveTo(150,-175);context.lineTo(94,-128);context.lineTo(155,-99);context.closePath();context.fill();
  for(const x of [-79,79]) {context.fillStyle='#fff';context.beginPath();context.ellipse(x,-4,43,51,0,0,Math.PI*2);context.fill();context.fillStyle='#303529';context.beginPath();context.ellipse(x+8,-3,13,24,0,0,Math.PI*2);context.fill();}
  context.fillStyle='#584435';context.beginPath();context.moveTo(-15,64);context.quadraticCurveTo(0,51,15,64);context.lineTo(0,82);context.closePath();context.fill();context.strokeStyle='#584435';context.lineWidth=5;context.lineCap='round';context.beginPath();context.moveTo(0,80);context.quadraticCurveTo(-12,109,-34,90);context.moveTo(0,80);context.quadraticCurveTo(12,109,34,90);context.stroke();context.restore();
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  await upload(new File([blob],'示例_发呆小猫.png',{type:'image/png'}));
}
document.querySelectorAll('[data-tool]').forEach(button=>button.addEventListener('click',()=>switchTool(button.dataset.tool)));
$('dropzone').addEventListener('click',()=>{if(!state.busy)$('file-input').click();});
$('dropzone').addEventListener('keydown',event=>{if(event.target===$('dropzone') && ['Enter',' '].includes(event.key)) {event.preventDefault();$('file-input').click();}});
$('replace').addEventListener('click',()=>$('file-input').click());
$('file-input').addEventListener('change',event=>{upload(event.target.files[0]);event.target.value='';});
for(const eventName of ['dragenter','dragover']) $('dropzone').addEventListener(eventName,event=>{event.preventDefault();$('dropzone').classList.add('dragging');});
for(const eventName of ['dragleave','drop']) $('dropzone').addEventListener(eventName,event=>{event.preventDefault();$('dropzone').classList.remove('dragging');});
$('dropzone').addEventListener('drop',event=>upload(event.dataTransfer.files[0]));
document.addEventListener('dragover',event=>event.preventDefault());document.addEventListener('drop',event=>event.preventDefault());
$('process').addEventListener('click',processMedia);$('sample').addEventListener('click',sample);
$('cancel').addEventListener('click',()=>{engine.cancel();$('progress-message').textContent='正在取消…';});
$('share').addEventListener('click',async()=>{try {if(state.result?.file)await navigator.share({files:[state.result.file],title:'MemeFactory 表情工厂'});}catch(error){if(error.name!=='AbortError')notice('系统分享未完成，可以使用下载或长按保存。',true);}});
$('settings-form').addEventListener('submit',event=>{event.preventDefault();processMedia();});
for(const id of ['threshold','softness']) $(id).addEventListener('input',()=>{$(`${id}-value`).textContent=$(id).value;});
$('settings-form').addEventListener('input',()=>{if(state.result){clearResult();notice('设置已修改，重新处理后即可下载新结果。');}});
$('reset').addEventListener('click',()=>{$('settings-form').reset();for(const id of ['threshold','softness'])$(`${id}-value`).textContent=$(id).value;clearResult();notice();});
document.querySelectorAll('[data-background]').forEach(button=>button.addEventListener('click',()=>{for(const candidate of document.querySelectorAll('[data-background]')){const selected=candidate===button;candidate.classList.toggle('selected',selected);candidate.setAttribute('aria-pressed',String(selected));}for(const id of ['original-pane','result-pane'])$(id).className=`media-pane ${button.dataset.background}`;}));
api('/api/status').then(status=>{state.token=status.token;state.ffmpeg=status.ffmpeg;switchTool('white');controls();}).catch(()=>{$('connection-error').hidden=false;controls();});
