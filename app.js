// Schematic Studio — v2 from scratch
// Single-file module orchestrating UI, viewer, tools, and persistence.

/*
  High-level architecture
  - App: bootstraps UI and wires events
  - State: pages, annotations, layers, enhancements, scale calibration
  - Viewer: high-perf canvas with zoom/pan and overlay rendering
  - Tools: pan, annotate (rect/text/arrow), measure, calibrate
  - IO: import images (drag/drop/input), export/import project JSON
*/

const $$ = (sel, root=document) => root.querySelector(sel);
const $$$ = (sel, root=document) => [...root.querySelectorAll(sel)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DPR = () => (window.devicePixelRatio || 1);
// Safe UUID generator (fallback if crypto.randomUUID is unavailable)
const uuid = () => {
  try{ if(typeof crypto!=='undefined' && typeof crypto.randomUUID==='function') return crypto.randomUUID() }catch(_){ }
  try{
    if(typeof crypto!=='undefined' && typeof crypto.getRandomValues==='function'){
      const b=new Uint8Array(16); crypto.getRandomValues(b);
      b[6]=(b[6]&0x0f)|0x40; b[8]=(b[8]&0x3f)|0x80;
      const h=[...b].map(x=>x.toString(16).padStart(2,'0'));
      return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
    }
  }catch(_){ }
  let d=Date.now();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
    const r = (d + Math.random()*16) % 16 | 0; d=Math.floor(d/16);
    return (c==='x'?r:(r&0x3)|0x8).toString(16);
  });
};

class Emitter {
  constructor(){this.map=new Map()}
  on(t,fn){const a=this.map.get(t)||[];a.push(fn);this.map.set(t,a);return()=>this.off(t,fn)}
  off(t,fn){const a=this.map.get(t)||[];const i=a.indexOf(fn);if(i>=0)a.splice(i,1)}
  emit(t,p){(this.map.get(t)||[]).forEach(f=>{try{f(p)}catch(e){console.error(e)}})}
}

class PageImage {
  constructor(id, name, bitmap){
    this.id = id;
    this.name = name;
    this.bitmap = bitmap; // ImageBitmap (source of truth)
    this.processedCanvas = null; // Offscreen rendering for enhancements
    this.thumbDataUrl = null; // for sidebar
    this.enhance = {brightness:0, contrast:0, threshold:0, invert:false, grayscale:false, sharpen:0};
    this.layers = [ { id: 'default', name: 'Default', visible:true } ];
    this.activeLayerId = 'default';
    this.annotations = []; // [{id,type,layerId, points:[{x,y}], text, props}]
    this.scale = { // pixels per unit
      unit: 'in', // in, cm, mm
      pixelsPerUnit: 10,
    };
  }
}

class AppState extends Emitter {
  constructor(){
    super();
    this.pages = []; // PageImage[]
    this.current = -1;
  }
  get page(){return this.pages[this.current] || null}
  addPage(name, bitmap){
    const id = uuid();
    const p = new PageImage(id, name, bitmap);
    this.pages.push(p); this.current = this.pages.length - 1; this.emit('pages',null);
    return p;
  }
  removePage(id){
    const idx = this.pages.findIndex(p=>p.id===id);
    if(idx>=0){ this.pages.splice(idx,1); if(this.current>=this.pages.length) this.current=this.pages.length-1; this.emit('pages',null); }
  }
  setCurrent(idx){ this.current = clamp(idx,0,this.pages.length-1); this.emit('current',null) }
}

class Viewer extends Emitter {
  constructor(root){
    super();
    this.root = root;
    this.wrap = $$('.canvas-wrap', root);
    this.canvas = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'overlay';
    this.wrap.appendChild(this.canvas);
    this.wrap.appendChild(this.overlay);
    this.ctx = this.canvas.getContext('2d', { alpha:false, desynchronized:true });
    this.octx = this.overlay.getContext('2d');
    this.w = this.h = 0;
    this.state = { x:0, y:0, scale:1 };
    this.minScale = 0.02; this.maxScale = 40;
    this.drag = null;
    this.hover = null;
    this.renderPending = false;
    this.fitWhenReady = true;
    this.log = (window.DEBUG_MEMO_LOG)||(()=>{});
    this._initEvents();
    this.resize();
  }
  resize(){
    const r = this.wrap.getBoundingClientRect();
    this.w = Math.max(1, r.width|0); this.h = Math.max(1, r.height|0);
    const d = DPR();
    [this.canvas, this.overlay].forEach(c=>{c.width=this.w*d; c.height=this.h*d; c.style.width=this.w+'px'; c.style.height=this.h+'px'});
    this.ctx.setTransform(d,0,0,d,0,0);
    this.octx.setTransform(d,0,0,d,0,0);
    this.requestRender();
  }
  setImage(page){ this.page = page; if(page?.bitmap){ this.log('viewer:setImage', {w:page.bitmap.width,h:page.bitmap.height}) } if(this.fitWhenReady) this.fit(); this.requestRender(); }
  setEnhance(){ this.requestRender(true); }
  screenToWorld(px,py){
    const {x,y,scale} = this.state; return { x:(px-x)/scale, y:(py-y)/scale };
  }
  worldToScreen(wx,wy){ const {x,y,scale}=this.state; return { x: wx*scale + x, y: wy*scale + y } }
  fit(){
    if(!this.page?.bitmap) return;
    const bw = this.page.bitmap.width, bh = this.page.bitmap.height;
    const pad = 20; const sw = this.w - pad*2, sh = this.h - pad*2;
    const s = Math.min(sw/bw, sh/bh); this.state.scale = clamp(s, this.minScale, this.maxScale);
    const cx = (this.w - bw*this.state.scale)/2; const cy = (this.h - bh*this.state.scale)/2;
    this.state.x = cx; this.state.y = cy; this.requestRender();
    try{ (window.DEBUG_MEMO_LOG||(()=>{}))('viewer:fit', {canvas:{w:this.w,h:this.h}, image:{w:bw,h:bh}, scale:this.state.scale}) }catch(_){ }
  }
  zoomAt(factor, cx, cy){
    const {x,y,scale} = this.state;
    const wx = (cx - x) / scale; const wy = (cy - y) / scale;
    const ns = clamp(scale*factor, this.minScale, this.maxScale);
    this.state.scale = ns;
    this.state.x = cx - wx*ns; this.state.y = cy - wy*ns;
    this.requestRender();
  }
  requestRender(force=false){
    if(this.renderPending && !force) return; this.renderPending=true;
    queueMicrotask(()=>{ this.renderPending=false; this._render() });
  }
  clear(){ this.ctx.fillStyle = '#0b0e17'; this.ctx.fillRect(0,0,this.w,this.h); this.octx.clearRect(0,0,this.w,this.h); }
  _render(){
    this.clear(); const page = this.page; if(!page?.bitmap) return;
    const img = page.processedCanvas || page.bitmap;
    const {x,y,scale} = this.state;
    const dw = img.width * scale; const dh = img.height * scale;
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(img, 0,0,img.width,img.height, x,y,dw,dh);
    // Grid (optional subtle)
    this._drawGrid();
    // Annotations overlay
    this._drawAnnotations();
  }
  _drawGrid(){
    const {scale} = this.state; if(scale < 0.2) return;
    const step = 50; const {x,y} = this.state;
    const left = -x/scale, top = -y/scale; const right = (this.w-x)/scale, bottom=(this.h-y)/scale;
    const s = step; this.octx.save(); this.octx.strokeStyle='rgba(255,255,255,0.06)'; this.octx.lineWidth=1;
    this.octx.beginPath();
    for(let gx=Math.floor(left/s)*s; gx<right; gx+=s){ const p1=this.worldToScreen(gx,top); const p2=this.worldToScreen(gx,bottom); this.octx.moveTo(p1.x, p1.y); this.octx.lineTo(p2.x,p2.y) }
    for(let gy=Math.floor(top/s)*s; gy<bottom; gy+=s){ const p1=this.worldToScreen(left,gy); const p2=this.worldToScreen(right,gy); this.octx.moveTo(p1.x, p1.y); this.octx.lineTo(p2.x,p2.y) }
    this.octx.stroke(); this.octx.restore();
  }
  _drawAnnotations(){
    const page = this.page; if(!page) return; const anns = page.annotations;
    const ctx=this.octx; ctx.save(); ctx.lineWidth=1; ctx.font='12px ui-sans-serif';
    for(const a of anns){
      const layer = page.layers.find(l=>l.id===a.layerId); if(layer && !layer.visible) continue;
      switch(a.type){
        case 'rect': this._drawRect(a); break;
        case 'arrow': this._drawArrow(a); break;
        case 'text': this._drawText(a); break;
        case 'measure': this._drawMeasure(a); break;
        case 'highlight': this._drawHighlight(a); break;
      }
    }
    ctx.restore();
  }
  _p(pt){ return this.worldToScreen(pt.x, pt.y) }
  _drawRect(a){
    const ctx=this.octx; ctx.save(); ctx.strokeStyle=a.props?.color||'#6df2bf'; ctx.setLineDash(a.props?.dash?[4,4]:[]);
    const p1=this._p(a.points[0]), p2=this._p(a.points[1]); const x=Math.min(p1.x,p2.x), y=Math.min(p1.y,p2.y), w=Math.abs(p1.x-p2.x), h=Math.abs(p1.y-p2.y);
    ctx.strokeRect(x,y,w,h); ctx.restore();
  }
  _drawArrow(a){
    const ctx=this.octx; ctx.save(); ctx.strokeStyle=a.props?.color||'#4cc2ff'; ctx.fillStyle=ctx.strokeStyle; ctx.lineWidth=1.5;
    const p1=this._p(a.points[0]), p2=this._p(a.points[1]);
    ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y); ctx.stroke();
    const ang=Math.atan2(p2.y-p1.y,p2.x-p1.x); const size=8;
    ctx.beginPath(); ctx.moveTo(p2.x,p2.y); ctx.lineTo(p2.x-size*Math.cos(ang-0.4), p2.y-size*Math.sin(ang-0.4));
    ctx.lineTo(p2.x-size*Math.cos(ang+0.4), p2.y-size*Math.sin(ang+0.4)); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  _drawText(a){
    const ctx=this.octx; ctx.save(); ctx.fillStyle=a.props?.color||'#ffd166'; ctx.strokeStyle='#0009'; ctx.lineWidth=3;
    const p=this._p(a.points[0]); const text=a.text||''; ctx.font='13px ui-sans-serif';
    ctx.strokeText(text, p.x+1, p.y+1); ctx.fillText(text, p.x, p.y); ctx.restore();
  }
  _drawHighlight(a){
    const ctx=this.octx; ctx.save();
    const color=a.props?.color||'#ffd166';
    ctx.strokeStyle=color; ctx.lineWidth=a.props?.width||4; ctx.lineCap='round';
    ctx.shadowColor=color; ctx.shadowBlur=8;
    const p1=this._p(a.points[0]), p2=this._p(a.points[1]);
    ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y); ctx.stroke();
    ctx.restore();
  }
  _drawMeasure(a){
    const ctx=this.octx; ctx.save(); ctx.strokeStyle='#e8ecf1'; ctx.fillStyle='#e8ecf1';
    const p1=this._p(a.points[0]), p2=this._p(a.points[1]);
    ctx.setLineDash([6,4]); ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y); ctx.stroke(); ctx.setLineDash([]);
    const midx=(p1.x+p2.x)/2, midy=(p1.y+p2.y)/2; const text=a.props?.label||'';
    if(text){ ctx.font='12px ui-sans-serif'; ctx.fillStyle='#0b0e17'; ctx.strokeStyle='#e8ecf1';
      const pad=4; const w=ctx.measureText(text).width+pad*2; const h=18;
      ctx.beginPath(); ctx.roundRect(midx-w/2, midy-20, w, h, 6); ctx.fill(); ctx.stroke();
      ctx.fillStyle='#e8ecf1'; ctx.fillText(text, midx-w/2+pad, midy-6);
    }
    ctx.restore();
  }
  _initEvents(){
    window.addEventListener('resize', ()=>this.resize());
    // Pointer events for pan + tool delegation
    this.overlay.style.pointerEvents='auto';
    this.overlay.addEventListener('contextmenu', e=>e.preventDefault());
    this.overlay.addEventListener('pointerdown', e=>{
      this.overlay.setPointerCapture(e.pointerId);
      const rect=this.overlay.getBoundingClientRect(); const px=e.clientX-rect.left, py=e.clientY-rect.top;
      const world=this.screenToWorld(px,py);
      this.emit('pointerdown', {e, px, py, world});
      const shouldPan = typeof this.shouldPan==='function' ? this.shouldPan() : true;
      // Pan with middle mouse always; left only if tool indicates panning
      if(e.button===1 || (e.button===0 && shouldPan)){
        e.preventDefault();
        this.drag = {startX:px, startY:py, ox:this.state.x, oy:this.state.y};
      }
    });
    this.overlay.addEventListener('pointermove', e=>{
      const rect=this.overlay.getBoundingClientRect(); const px=e.clientX-rect.left, py=e.clientY-rect.top;
      const world=this.screenToWorld(px,py);
      this.emit('pointermove', {e, px, py, world});
      if(this.drag){ this.state.x = this.drag.ox + (px - this.drag.startX); this.state.y = this.drag.oy + (py - this.drag.startY); this.requestRender(); }
    });
    const end=(e)=>{ this.emit('pointerup',{e}); this.drag=null; };
    this.overlay.addEventListener('pointerup', end);
    this.overlay.addEventListener('pointercancel', end);
    // Wheel zoom (Ctrl or two-finger trackpad)
    this.overlay.addEventListener('wheel', e=>{
      e.preventDefault();
      const rect=this.overlay.getBoundingClientRect(); const cx=e.clientX-rect.left, cy=e.clientY-rect.top;
      let factor = 1;
      const delta = (e.deltaY || 0);
      const z = Math.exp(-delta * 0.0015); // smooth zoom
      factor = z;
      if(!e.ctrlKey && Math.abs(delta)<5){ return; }
      this.zoomAt(factor, cx, cy);
    }, { passive:false });
    // Double click to zoom in
    this.overlay.addEventListener('dblclick', e=>{
      const rect=this.overlay.getBoundingClientRect(); const cx=e.clientX-rect.left, cy=e.clientY-rect.top;
      this.zoomAt(1.6, cx, cy);
    });
  }
}

// Enhancement pipeline (runs onto offscreen canvas when params change)
async function applyEnhancements(bitmap, params){
  const {brightness=0, contrast=0, threshold=0, invert=false, grayscale=false, sharpen=0} = params||{};
  const w = bitmap.width, h = bitmap.height;
  // cap processing size to keep responsive; scale down if too large while preserving effective resolution on display
  const maxPixels = 4_000_000; // ~4MP
  const scale = Math.min(1, Math.sqrt(maxPixels/(w*h)));
  const tw = Math.max(1, Math.round(w*scale)), th = Math.max(1, Math.round(h*scale));

  const off = document.createElement('canvas'); off.width = tw; off.height = th; const ctx = off.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0,0,w,h, 0,0,tw,th);
  let img = ctx.getImageData(0,0,tw,th); let d = img.data;

  // Precompute contrast factor
  const c = clamp(contrast, -100, 100); const cf = (259*(c+255))/(255*(259-c));
  const b = clamp(brightness, -100, 100);
  const thr = clamp(threshold, 0, 100);
  for(let i=0;i<d.length;i+=4){
    let r=d[i], g=d[i+1], bgr=d[i+2];
    // grayscale first if requested (luma)
    if(grayscale){ const l = (0.2126*r + 0.7152*g + 0.0722*bgr)|0; r=g=bgr=l }
    // brightness/contrast
    if(contrast||brightness){ r=cf*(r-128)+128 + b; g=cf*(g-128)+128 + b; bgr=cf*(bgr-128)+128 + b; }
    // invert
    if(invert){ r=255-r; g=255-g; bgr=255-bgr; }
    // threshold (binary) if set
    if(thr>0){ const l = (r+g+bgr)/3; const t = (thr/100)*255; const v = l>=t?255:0; r=g=bgr=v }
    d[i] = r<0?0:r>255?255:r; d[i+1] = g<0?0:g>255?255:g; d[i+2] = bgr<0?0:bgr>255?255:bgr;
  }
  ctx.putImageData(img,0,0);
  if(sharpen>0){ convolveSharpen(ctx, tw, th, sharpen) }
  // If scaled, upscale to original size without smoothing so pixels remain crisp
  if(scale!==1){
    const full = document.createElement('canvas'); full.width=w; full.height=h; const fctx=full.getContext('2d'); fctx.imageSmoothingEnabled=false;
    fctx.drawImage(off,0,0,tw,th,0,0,w,h); return full;
  }
  return off;
}

function convolveSharpen(ctx, w, h, amount){
  const k = amount; // 0..100
  const a = clamp(k/100, 0, 1);
  // kernel = identity + a*(sharpen)
  const wImg = ctx.getImageData(0,0,w,h); const src=wImg.data; const out=ctx.createImageData(w,h); const dst=out.data;
  const idx=(x,y)=>((y*w+x)<<2);
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      const i = idx(x,y); const c = idx(x,y);
      for(let ch=0;ch<3;ch++){
        const v = 5*src[c+ch] - src[idx(x-1,y)+ch] - src[idx(x+1,y)+ch] - src[idx(x,y-1)+ch] - src[idx(x,y+1)+ch];
        const nv = clamp(Math.round(src[c+ch]*(1-a) + v*a), 0, 255);
        dst[i+ch]=nv;
      }
      dst[i+3]=src[c+3];
    }
  }
  ctx.putImageData(out,0,0);
}

// Simple persistence helpers
function download(filename, dataUrl){
  const a=document.createElement('a'); a.href=dataUrl; a.download=filename; a.click();
}
function toDataURL(blob){ return new Promise(res=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.readAsDataURL(blob); }) }
async function fileToBitmap(file){
  const lower = (file.name||'').toLowerCase();
  if(lower.endsWith('.tif') || lower.endsWith('.tiff')){
    try{
      await ensureUTIF();
      const buf = await file.arrayBuffer();
      const ifds = UTIF.decode(buf);
      if(!ifds || ifds.length===0) throw new Error('No TIFF frames');
      UTIF.decodeImage(buf, ifds[0]);
      const rgba = UTIF.toRGBA8(ifds[0]);
      const w = ifds[0].width, h = ifds[0].height;
      const c = document.createElement('canvas'); c.width=w; c.height=h; const ctx=c.getContext('2d');
      const imgData = new ImageData(new Uint8ClampedArray(rgba), w, h);
      ctx.putImageData(imgData, 0, 0);
      if('createImageBitmap' in window){ try{ return await createImageBitmap(c) }catch(_e){ return c } }
      return c;
    }catch(e){ console.error('TIFF decode failed', e) }
  }
  try{ return await createImageBitmap(file) }catch(_){
    try{
      const url = URL.createObjectURL(file);
      const img = await new Promise((res,rej)=>{ const im=new Image(); im.onload=()=>res(im); im.onerror=rej; im.src=url });
      const c=document.createElement('canvas'); c.width=img.naturalWidth||img.width; c.height=img.naturalHeight||img.height; c.getContext('2d').drawImage(img,0,0);
      if('createImageBitmap' in window){ try{ return await createImageBitmap(c) }catch(_e){ return c } } else { return c }
    }catch(e){ throw e }
  }
}

function ensureUTIF(){
  return new Promise((resolve, reject)=>{
    if(window.UTIF){ resolve(window.UTIF); return }
    const s=document.createElement('script'); s.src='https://unpkg.com/utif@3.1.0/UTIF.min.js'; s.async=true;
    s.onload=()=>window.UTIF?resolve(window.UTIF):reject(new Error('UTIF not available'));
    s.onerror=()=>reject(new Error('Failed to load UTIF'));
    document.head.appendChild(s);
  });
}

class AppUI {
  constructor(){
    this.root = document.body;
    this.state = new AppState();
    this.viewer = new Viewer($$('.main'));
    this._bindViewer();
    this._setupToolbar();
    this._setupLeft();
    this._setupRight();
    this._setupDnD();
    this._setupStatus();
    this._setupToast();
    this._setupHelp();
    this._setupDebugPanel();
    this._wireState();
    this._setupAutosave();
  }
  _bindViewer(){
    this.state.on('current', ()=>{ this.viewer.setImage(this.state.page); this._refreshRight(); this._refreshStatus(); this._refreshThumbs() });
    this.state.on('pages', ()=>{ this._refreshThumbs(); this._refreshStatus(); this.viewer.setImage(this.state.page) });
    window.addEventListener('keydown', e=>this._hotkeys(e));
  }
  _setupToolbar(){
    this.openBtn = $$('#btn-open'); this.saveBtn=$$('#btn-save');
    this.fitBtn = $$('#btn-fit'); this.zoomInBtn=$$('#btn-zoom-in'); this.zoomOutBtn=$$('#btn-zoom-out');
    this.panBtn=$$('#tool-pan'); this.rectBtn=$$('#tool-rect'); this.arrowBtn=$$('#tool-arrow'); this.textBtn=$$('#tool-text'); this.measureBtn=$$('#tool-measure');
    // Ensure highlight tool button exists in DOM (inject if missing)
    this.highlightBtn=$$('#tool-highlight');
    if(!this.highlightBtn){
      const tb=$$('.tool-group.toolbox');
      if(tb){ const b=document.createElement('button'); b.id='tool-highlight'; b.title='Highlight line (6)'; b.innerHTML='<span class="i">==</span> Highlight'; tb.appendChild(b); this.highlightBtn=b; }
    }
    this.fileInput=$$('#file-input');
    const setTool = t=>{ this.tool=t; this.viewer.shouldPan = ()=> this.tool==='pan'; this._syncToolButtons() };
    const v=this.viewer;
    // Open is a <label for="file-input"> for broad browser support; keep a JS fallback too.
    this.openBtn.addEventListener('click', ()=> { try{ this.fileInput.showPicker?.() }catch(_){} });
    this.fileInput.addEventListener('change', async (e)=>{
      const files = [...(e.target.files||[])];
      if(files.length===0) return;
      this._debug('open:files', {count:files.length, names:files.map(f=>f.name)});
      await this._importFiles(files);
      e.target.value='';
    });
    this.saveBtn.addEventListener('click', ()=>this._exportProject());
    this.fitBtn.addEventListener('click', ()=>v.fit());
    this.zoomInBtn.addEventListener('click', ()=>v.zoomAt(1.25, v.w/2, v.h/2));
    this.zoomOutBtn.addEventListener('click', ()=>v.zoomAt(1/1.25, v.w/2, v.h/2));
    this.panBtn.addEventListener('click', ()=>setTool('pan'));
    this.rectBtn.addEventListener('click', ()=>setTool('rect'));
    this.arrowBtn.addEventListener('click', ()=>setTool('arrow'));
    this.textBtn.addEventListener('click', ()=>setTool('text'));
    this.measureBtn.addEventListener('click', ()=>setTool('measure'));
    if(this.highlightBtn){ this.highlightBtn.addEventListener('click', ()=>setTool('highlight')) }
    setTool('pan');
    const debugBtn = $$('#btn-debug'); if(debugBtn){ debugBtn.addEventListener('click', ()=>this._toggleDebug()) }

    // Tool interactions bridged through viewer pointer events
    let drawing=null;
    this.viewer.on('pointerdown', ({e, px, py, world})=>{
      if(!this.state.page) return;
      if(this.tool==='pan') return; // viewer will pan by default
      e.preventDefault();
      if(this.tool==='highlight'){
        this._highlightAt(world).catch(err=>{ this._debug('highlight:error', String(err&&err.message||err)) });
        return;
      }
      if(this.tool==='text'){
        const text = prompt('Enter label text');
        if(text){ this._addAnnotation({type:'text', points:[world], text, props:{color:'#ffd166'}}); }
        return false;
      }
      // start two-point shapes
      drawing = { start: world, last: world };
    });
    this.viewer.on('pointermove', ({world})=>{
      if(!drawing) return; drawing.last = world; this._previewTwoPoint(drawing.start, drawing.last);
    });
    this.viewer.on('pointerup', ()=>{
      if(!drawing) return; const {start,last}=drawing; drawing=null;
      if(this.tool==='rect') this._addAnnotation({type:'rect', points:[start,last], props:{color:'#6df2bf'}});
      if(this.tool==='arrow') this._addAnnotation({type:'arrow', points:[start,last], props:{color:'#4cc2ff'}});
      if(this.tool==='measure') this._addMeasure(start,last);
      this._clearPreview();
    });
  }
  _setupLeft(){
    this.thumbsWrap = $$('.thumbs');
  }
  _setupRight(){
    // Enhancement controls
    this.brightness=$$('#enh-bright'); this.contrast=$$('#enh-contrast'); this.threshold=$$('#enh-threshold'); this.invert=$$('#enh-invert'); this.gray=$$('#enh-gray'); this.sharpen=$$('#enh-sharpen');
    const apply=()=>this._applyEnhancements();
    [this.brightness,this.contrast,this.threshold,this.sharpen].forEach(r=>r.addEventListener('input', apply));
    [this.invert,this.gray].forEach(c=>c.addEventListener('change', apply));
    // Scale calibration
    this.unitSel=$$('#unit'); this.ppuInput=$$('#ppu');
    this.unitSel.addEventListener('change', ()=>this._updateScale());
    this.ppuInput.addEventListener('change', ()=>this._updateScale());

    // Highlight tool options
    this.hlWidth=$$('#hl-width');
    try{ const saved=localStorage.getItem('hlWidth'); if(saved && this.hlWidth){ this.hlWidth.value=saved } }catch(_){ }
    if(this.hlWidth){ this.hlWidth.addEventListener('input', ()=>{ try{ localStorage.setItem('hlWidth', this.hlWidth.value) }catch(_){ } }); }
    this.hlStop=$$('#hl-stop');
    try{ const s=localStorage.getItem('hlStop'); if(this.hlStop && (s==='0'||s==='1')) this.hlStop.checked = (s!=='0') }catch(_){ }
    if(this.hlStop){ this.hlStop.addEventListener('change', ()=>{ try{ localStorage.setItem('hlStop', this.hlStop.checked?'1':'0') }catch(_){ } }); }
    this.hlJunc=$$('#hl-junc');
    try{ const v=localStorage.getItem('hlJunc'); if(this.hlJunc && v!==null) this.hlJunc.value=v }catch(_){ }
    if(this.hlJunc){ this.hlJunc.addEventListener('input', ()=>{ try{ localStorage.setItem('hlJunc', this.hlJunc.value) }catch(_){ } }); }
    this.hlExtend=$$('#hl-extend');
    try{ const e=localStorage.getItem('hlExtend'); if(this.hlExtend && e!==null) this.hlExtend.value=e }catch(_){ }
    if(this.hlExtend){ this.hlExtend.addEventListener('input', ()=>{ try{ localStorage.setItem('hlExtend', this.hlExtend.value) }catch(_){ } }); }

    // Layers UI
    this.layersList=$$('#layers-list'); this.layerAdd=$$('#layer-add'); this.layerRename=$$('#layer-rename'); this.layerDelete=$$('#layer-delete'); this.layerActive=$$('#layer-active');
    this.layerAdd.addEventListener('click', ()=>this._addLayer());
    this.layerRename.addEventListener('click', ()=>this._renameActiveLayer());
    this.layerDelete.addEventListener('click', ()=>this._deleteActiveLayer());
    this.layerActive.addEventListener('change', ()=>{ const id=this.layerActive.value; this._setActiveLayer(id) });

    // OpenCV controls
    this.cvLoad=$$('#cv-load'); this.cvDeskew=$$('#cv-deskew'); this.cvDenoise=$$('#cv-denoise'); this.cvAdapt=$$('#cv-adapt'); this.cvReset=$$('#cv-reset');
    const need=async()=>{ if(window.cvWorker && window.cvWorkerReady) return true; try{ await loadOpenCV(this.cvLoad) ; return true }catch(e){ alert('Failed to load OpenCV'); return false } };
    this.cvLoad.addEventListener('click', async()=>{ await need() });
    this.cvDeskew.addEventListener('click', async()=>{ if(await need()) this._cvDeskew() });
    this.cvDenoise.addEventListener('click', async()=>{ if(await need()) this._cvDenoise() });
    this.cvAdapt.addEventListener('click', async()=>{ if(await need()) this._cvAdaptive() });
    this.cvReset.addEventListener('click', ()=>{ const p=this.state.page; if(!p) return; p.cvCanvas=null; this._applyEnhancements(p) });
  }
  _renderLayers(){
    const p=this.state.page; const list=this.layersList; const activeSel=this.layerActive; list.innerHTML=''; activeSel.innerHTML='';
    if(!p){ return }
    p.layers.forEach(l=>{
      const row=document.createElement('div'); row.className='layer-row'+(l.id===p.activeLayerId?' active':''); row.dataset.id=l.id;
      row.innerHTML = `
        <input class="vis" type="checkbox" ${l.visible?'checked':''} title="Toggle visibility"/>
        <div class="name" contenteditable="false" spellcheck="false" title="Double-click to rename">${l.name}</div>
      `;
      const vis=row.querySelector('.vis'); vis.addEventListener('change',()=>{ l.visible=vis.checked; this.viewer.requestRender(); this._queueAutosave() });
      row.addEventListener('click', (e)=>{ if(e.target.classList.contains('vis')) return; this._setActiveLayer(l.id) });
      row.addEventListener('dblclick', ()=>{ this._renameLayerInline(row, l) });
      list.appendChild(row);
      const opt=document.createElement('option'); opt.value=l.id; opt.textContent=l.name; if(l.id===p.activeLayerId) opt.selected=true; activeSel.appendChild(opt);
    });
  }
  _renameLayerInline(row, layer){
    const nameEl=row.querySelector('.name'); nameEl.contentEditable='true'; nameEl.focus();
    const sel=window.getSelection(); const range=document.createRange(); range.selectNodeContents(nameEl); sel.removeAllRanges(); sel.addRange(range);
    const done=()=>{ nameEl.contentEditable='false'; const v=nameEl.textContent.trim()||'Layer'; layer.name=v; this._renderLayers(); this._queueAutosave() };
    const onKey=(e)=>{ if(e.key==='Enter'){ e.preventDefault(); nameEl.blur() } if(e.key==='Escape'){ e.preventDefault(); nameEl.textContent=layer.name; nameEl.blur() } };
    nameEl.addEventListener('blur', done, {once:true});
    nameEl.addEventListener('keydown', onKey);
  }
  _setActiveLayer(id){ const p=this.state.page; if(!p) return; p.activeLayerId=id; this._renderLayers(); }
  _addLayer(){
    const p=this.state.page; if(!p) return; const name=prompt('New layer name','Layer '+(p.layers.length+1)); if(!name) return;
    const id=uuid(); p.layers.push({id,name,visible:true}); p.activeLayerId=id; this._renderLayers(); this._queueAutosave();
  }
  _renameActiveLayer(){ const p=this.state.page; if(!p) return; const l=p.layers.find(x=>x.id===p.activeLayerId); if(!l) return; const name=prompt('Rename layer', l.name); if(!name) return; l.name=name; this._renderLayers(); this._queueAutosave(); }
  _deleteActiveLayer(){
    const p=this.state.page; if(!p) return; if(p.layers.length<=1){ alert('Cannot delete the last layer.'); return }
    const id=p.activeLayerId; const idx=p.layers.findIndex(l=>l.id===id); if(idx<0) return;
    if(!confirm('Delete current layer and move its annotations to the first layer?')) return;
    const target = p.layers.find((l,i)=>i!==idx) || p.layers[0];
    p.annotations.forEach(a=>{ if(a.layerId===id) a.layerId=target.id });
    p.layers.splice(idx,1); p.activeLayerId=target.id; this._renderLayers(); this.viewer.requestRender(); this._queueAutosave();
  }
  _setupStatus(){
    this.statusZoom=$$('#status-zoom'); this.statusPos=$$('#status-pos'); this.statusPage=$$('#status-page');
    this.viewer.on('pointermove', ({px,py})=>{ this.statusPos.textContent = `x:${px|0} y:${py|0}` });
  }
  _setupDnD(){
    const drop=$$('.drop-overlay'); const main=$$('.main');
    const on=()=>drop.classList.add('show'); const off=()=>drop.classList.remove('show');
    ['dragenter','dragover'].forEach(ev=>main.addEventListener(ev, e=>{ e.preventDefault(); on() }));
    ['dragleave','drop'].forEach(ev=>main.addEventListener(ev, e=>{ e.preventDefault(); off() }));
    main.addEventListener('drop', async e=>{ const files=[...e.dataTransfer.files]; if(!files.length){ return } this._debug('drop', {count:files.length, names:files.map(f=>f.name)}); await this._importFiles(files) });
  }
  _setupHelp(){
    this.help=$$('.help'); $$('#btn-help').addEventListener('click',()=>this.help.classList.toggle('show'));
  }
  _setupDebugPanel(){
    this.debugPanel = $$('#debug-panel'); this.debugMemo = $$('#debug-memo'); this.debugCopy=$$('#debug-copy'); this.debugClear=$$('#debug-clear');
    if(this.debugCopy) this.debugCopy.addEventListener('click', ()=>{ try{ this.debugMemo.select(); document.execCommand('copy'); this._toast('Copied debug memo','ok') }catch(_){ navigator.clipboard?.writeText(this.debugMemo.value).then(()=>this._toast('Copied debug memo','ok')) } });
    if(this.debugClear) this.debugClear.addEventListener('click', ()=>{ this.debugMemo.value=''; this._toast('Cleared debug memo','ok') });
    // Auto-show if hash or previous state requested it
    try{
      const want = (location.hash||'').includes('debug') || localStorage.getItem('debugPanel')==='1';
      if(want && this.debugPanel){ this.debugPanel.classList.remove('hidden') }
    }catch(_){ }
    this._debug('boot', { ua:navigator.userAgent, protocol:location.protocol, sw:'serviceWorker' in navigator, features:{ createImageBitmap: !!window.createImageBitmap } });
    window.DEBUG_MEMO_LOG = (tag,data)=>this._debug(tag,data);
    // Global error hooks to capture issues in the debug panel
    window.addEventListener('error', (e)=>{
      try{
        this._debug('window:error', { message: e.message, src: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack });
      }catch(_){ /* noop */ }
    });
    window.addEventListener('unhandledrejection', (e)=>{
      try{
        const reason = e.reason; const msg = (reason && reason.message) || String(reason);
        this._debug('unhandledrejection', { message: msg, stack: reason?.stack });
      }catch(_){ /* noop */ }
    });
  }
  _toggleDebug(){ if(!this.debugPanel) return; this.debugPanel.classList.toggle('hidden'); try{ localStorage.setItem('debugPanel', this.debugPanel.classList.contains('hidden')?'0':'1') }catch(_){ } }
  _debug(tag, data){ try{ const ts=new Date().toISOString(); const payload=(typeof data==='string')?data:JSON.stringify(data); if(this.debugMemo){ this.debugMemo.value += `[${ts}] ${tag}: ${payload}\n`; this.debugMemo.scrollTop=this.debugMemo.scrollHeight } console.log(`[${ts}] ${tag}`, data); }catch(e){ try{ console.log(tag, data) }catch(_){} } }
  _wireState(){
    // reflect zoom
    const refresh=()=>{ const z = (this.viewer.state.scale*100)|0; this.statusZoom.textContent=`${z}%`; this.statusPage.textContent = this.state.page?`${this.state.current+1}/${this.state.pages.length}`:'0/0' };
    const renderRefresh = ()=>{ refresh(); this.viewer.requestRender() };
    // tick on transform changes via wheel
    this.viewer.requestRender = this.viewer.requestRender.bind(this.viewer);
    const origZoomAt = this.viewer.zoomAt.bind(this.viewer);
    this.viewer.zoomAt = (...args)=>{ origZoomAt(...args); refresh() };
  }
  _refreshStatus(){ const v=this.viewer; this.statusZoom.textContent = `${(v.state.scale*100)|0}%`; this.statusPage.textContent=this.state.page?`${this.state.current+1}/${this.state.pages.length}`:'0/0' }
  _refreshRight(){ this._renderLayers(); }
  _syncToolButtons(){
    const map = {pan:this.panBtn, rect:this.rectBtn, arrow:this.arrowBtn, text:this.textBtn, measure:this.measureBtn, highlight:this.highlightBtn};
    Object.entries(map).forEach(([k,btn])=>btn.setAttribute('aria-pressed', String(this.tool===k)));
  }
  async _importFiles(files){
    let ok=0;
    for(const f of files){
      try{
        this._debug('import:start', {name:f.name, type:f.type});
        if(f.type==='application/json' || f.name.toLowerCase().endsWith('.json')){
          const txt = await f.text(); const proj = JSON.parse(txt); await this._loadProject(proj); continue;
        }
        const lower = (f.name||'').toLowerCase();
        const allowExt = ['.png','.jpg','.jpeg','.bmp','.gif','.webp','.tif','.tiff'];
        const isAllowedByExt = allowExt.some(x=>lower.endsWith(x));
        if(!(f.type && f.type.startsWith('image/')) && !isAllowedByExt){ this._debug('import:skip', {name:f.name, reason:'not image type or extension'}); continue }
        const bmp = await fileToBitmap(f);
        this._debug('import:decoded', {name:f.name, width:bmp.width, height:bmp.height, ctor:bmp.constructor?.name});
        const page = this.state.addPage(f.name, bmp);
        this._debug('import:page-added', {index:this.state.current, total:this.state.pages.length});
        // Generate thumb
        page.thumbDataUrl = await this._bitmapToThumb(bmp);
        await this._applyEnhancements(page); ok++;
        this._debug('import:enhanced', {page:this.state.current, enhance:page.enhance});
      }catch(err){ console.error('Failed to import', f, err); this._debug('import:error', {name:f.name, message: String(err&&err.message||err)}); this._toast(`Failed to import ${f.name}: ${err?.message||err}`, 'error') }
    }
    this._queueAutosave();
    if(ok>0){ this._toast(`Imported ${ok} file${ok>1?'s':''}`, 'ok') }
  }
  async _bitmapToThumb(bitmap){
    const max=160; const r = Math.max(bitmap.width, bitmap.height); const s = max/r; const w=(bitmap.width*s)|0, h=(bitmap.height*s)|0;
    const c=document.createElement('canvas'); c.width=w; c.height=h; const ctx=c.getContext('2d'); ctx.imageSmoothingEnabled=false; ctx.drawImage(bitmap,0,0,bitmap.width,bitmap.height,0,0,w,h); return c.toDataURL('image/png');
  }
  _refreshThumbs(){
    const wrap=this.thumbsWrap; wrap.innerHTML='';
    this.state.pages.forEach((p,idx)=>{
      const el=document.createElement('div'); el.className='thumb'+(idx===this.state.current?' active':'');
      el.innerHTML = `<img alt="${p.name}">${''}<div class="meta"><span>${idx+1}</span><span>${p.bitmap.width}×${p.bitmap.height}</span></div>`;
      const img=el.querySelector('img'); img.src = p.thumbDataUrl || '';
      el.addEventListener('click', ()=>this.state.setCurrent(idx));
      wrap.appendChild(el);
    });
  }
  async _applyEnhancements(pageOverride){
    const p = pageOverride || this.state.page; if(!p) return;
    this._debug('enhance:start', {pageIndex:this.state.current});
    p.enhance = {
      brightness: +this.brightness.value,
      contrast: +this.contrast.value,
      threshold: +this.threshold.value,
      invert: this.invert.checked,
      grayscale: this.gray.checked,
      sharpen: +this.sharpen.value,
    };
    const base = p.cvCanvas || p.bitmap;
    p.processedCanvas = await applyEnhancements(base, p.enhance);
    this._debug('enhance:done', {canvas:{w:p.processedCanvas.width,h:p.processedCanvas.height}});
    if(p===this.state.page) this.viewer.requestRender(true);
  }
  _updateScale(){
    const p=this.state.page; if(!p) return;
    p.scale.unit = this.unitSel.value; p.scale.pixelsPerUnit = parseFloat(this.ppuInput.value)||p.scale.pixelsPerUnit;
    this.viewer.requestRender();
  }
  _addAnnotation(a){
    const p=this.state.page; if(!p) return; const layerId = p.activeLayerId || (p.layers[0]&&p.layers[0].id) || 'default';
    const ann={ id:uuid(), layerId, ...a };
    p.annotations.push(ann); this.viewer.requestRender();
    this._queueAutosave();
  }
  _addMeasure(start,last){
    const p=this.state.page; if(!p) return; const dx=last.x-start.x, dy=last.y-start.y; const pix=Math.hypot(dx,dy);
    const real = (pix / p.scale.pixelsPerUnit).toFixed(2) + ' ' + p.scale.unit;
    this._addAnnotation({type:'measure', points:[start,last], props:{label: real}});
  }
  async _highlightAt(world){
    const p=this.state.page; if(!p) return;
    try{
      // First try a quick, local scan-based detector (no OpenCV needed)
      const seg = this._scanForLineSegment(world.x|0, world.y|0);
      if(seg){
        const out = this._extendFromClick(world) || seg; const w = +(this.hlWidth?.value||6);
        this._addAnnotation({type:'highlight', points:[{x:out.x1,y:out.y1},{x:out.x2,y:out.y2}], props:{color:'#ffd166', width:w}});
        this._debug('highlight:scan', out);
        return;
      }
    }catch(_){ }
    // If scan fails, try OpenCV-based detection. If worker not loaded, attempt to load it (non-blocking to UI).
    try{
      if(!(window.cvWorker && window.cvWorkerReady)){
        this._debug('highlight:load-cv', {x:world.x,y:world.y});
        try{ await loadOpenCV(this.cvLoad); }catch(e){ this._debug('highlight:load-cv:error', String(e&&e.message||e)); this._toast('OpenCV load failed', 'error'); return }
      }
      const seg = await this._cvFindNearestLine(world.x, world.y);
      if(seg){
        const axis = (Math.abs(seg.x2-seg.x1)>=Math.abs(seg.y2-seg.y1))?'h':'v';
        const out = this._extendFromClick(world, axis) || seg; const w = +(this.hlWidth?.value||6);
        this._addAnnotation({type:'highlight', points:[{x:out.x1,y:out.y1},{x:out.x2,y:out.y2}], props:{color:'#ffd166', width:w}});
        this._debug('highlight:cv', out);
      } else {
        this._debug('highlight:none', { x:world.x, y:world.y });
      }
    }catch(e){ this._debug('highlight:cv:error', String(e&&e.message||e)); }
  }
  _scanForLineSegment(cx, cy){
    const p=this.state.page; if(!p) return null;
    const src = p.processedCanvas || p.cvCanvas || this._sourceCanvas();
    if(!src) return null; const w=src.width, h=src.height; if(cx<0||cy<0||cx>=w||cy>=h) return null;
    const ctx = src.getContext('2d');
    const clampXY=(v,lo,hi)=>v<lo?lo:v>hi?hi:v;
    const thickness = 3; const stripe = thickness*2+1; const gapTol=3; const minLen=12; // stricter gaps and min length
    // Use a local window to avoid false positives far away
    const win = Math.max(40, Math.min(140, (Math.max(w,h)*0.05)|0));
    const xL = clampXY(cx-win, 0, w-1), xR = clampXY(cx+win, 0, w-1);
    const yT = clampXY(cy-win, 0, h-1), yB = clampXY(cy+win, 0, h-1);
    // Estimate background brightness near click
    const patch = ctx.getImageData(xL, yT, xR-xL+1, yB-yT+1).data;
    let sum=0, count=0; for(let i=0;i<patch.length;i+=4){ const r=patch[i],g=patch[i+1],b=patch[i+2]; sum += (0.2126*r+0.7152*g+0.0722*b); count++; }
    const bg = sum/Math.max(1,count);
    const darkThr = Math.max(0, Math.min(255, bg - 40));
    const brightThr = Math.max(0, Math.min(255, bg + 40));
    const preferDark = bg > 140; // white-ish background => lines are dark
    const isLinePix = (l)=> preferDark ? (l <= darkThr) : (l >= brightThr);
    // Seed check: ensure there are line-like pixels very near the click
    {
      const seedRad=2; const sx = clampXY(cx-seedRad,0,w-1), sy=clampXY(cy-seedRad,0,h-1);
      const sw = Math.min(w-1, cx+seedRad) - sx + 1; const sh = Math.min(h-1, cy+seedRad) - sy + 1;
      const seed = ctx.getImageData(sx, sy, sw, sh).data; let hits=0; for(let i=0;i<seed.length;i+=4){ const r=seed[i],g=seed[i+1],b=seed[i+2]; const l=(0.2126*r+0.7152*g+0.0722*b)|0; if(isLinePix(l)) hits++; }
      if(hits < 6) return null; // not close enough to any stroke, bail out early
    }
    // Horizontal stripe within local window
    const y0 = clampXY(cy-thickness,0,h-1); const yH = clampXY(cy+thickness,0,h-1);
    const imgH = ctx.getImageData(xL, y0, xR-xL+1, yH-y0+1); const dH=imgH.data; const rows=yH-y0+1; const colsH=(xR-xL+1);
    const colHits = new Uint16Array(colsH);
    for(let y=0;y<rows;y++){
      for(let x=0;x<colsH;x++){
        const i=((y*colsH+x)<<2); const r=dH[i],g=dH[i+1],b=dH[i+2]; const l=(0.2126*r+0.7152*g+0.0722*b)|0; if(isLinePix(l)) colHits[x]++;
      }
    }
    const isH=(x)=>colHits[x] >= Math.max(1, stripe-1);
    let L=cx, R=cx, miss=0; while(L>xL){ if(isH(L-1-xL)) { L--; miss=0 } else { miss++; if(miss>gapTol) break } }
    miss=0; while(R<xR){ if(isH(R+1-xL)) { R++; miss=0 } else { miss++; if(miss>gapTol) break } }
    const lenH = R-L;
    // Vertical stripe within local window
    const x0 = clampXY(cx-thickness,0,w-1); const xV = clampXY(cx+thickness,0,w-1);
    const imgV = ctx.getImageData(x0, yT, xV-x0+1, yB-yT+1); const dV=imgV.data; const colsV=(xV-x0+1); const rowsV=(yB-yT+1);
    const rowHits = new Uint16Array(rowsV);
    for(let y=0;y<rowsV;y++){
      for(let x=0;x<colsV;x++){
        const i=((y*colsV+x)<<2); const r=dV[i],g=dV[i+1],b=dV[i+2]; const l=(0.2126*r+0.7152*g+0.0722*b)|0; if(isLinePix(l)) rowHits[y]++;
      }
    }
    const isV=(y)=>rowHits[y] >= Math.max(1, stripe-1);
    let T=cy, B=cy; miss=0; while(T>yT){ if(isV(T-1-yT)) { T--; miss=0 } else { miss++; if(miss>gapTol) break } }
    miss=0; while(B<yB){ if(isV(B+1-yT)) { B++; miss=0 } else { miss++; if(miss>gapTol) break } }
    const lenV = B-T;
    const bestLen = Math.max(lenH, lenV);
    if(bestLen < minLen) return null;
    if(lenH>=lenV){ return { x1:L, y1:cy, x2:R, y2:cy, kind:'h'} } else { return { x1:cx, y1:T, x2:cx, y2:B, kind:'v'} }
  }
  async _cvFindNearestLine(px, py){
    const p=this.state.page; if(!p) return null;
    if(!(window.cvWorker && window.cvWorkerReady)) return null;
    const s = this._sourceCanvas(); if(!s) return null; const w=s.width, h=s.height;
    // Build a small ROI around the click and send to worker
    const pad = Math.max(30, Math.min(120, (Math.max(w,h)*0.05)|0));
    const rx = Math.max(0, Math.min(w-1, Math.round(px-pad)));
    const ry = Math.max(0, Math.min(h-1, Math.round(py-pad)));
    const rw = Math.max(1, Math.min(w-rx, Math.round(2*pad)));
    const rh = Math.max(1, Math.min(h-ry, Math.round(2*pad)));
    const ctx = s.getContext('2d'); const imgData = ctx.getImageData(rx, ry, rw, rh);
    return new Promise((resolve)=>{
      const onMsg = (ev)=>{
        const d=ev.data||{}; if(d.type==='detectLine:result'){ window.cvWorker.removeEventListener('message', onMsg); resolve(d.seg||null) }
      };
      window.cvWorker.addEventListener('message', onMsg);
      window.cvWorker.postMessage({ type:'detectLine', roi:{ data:imgData.data.buffer, width:rw, height:rh, rx, ry }, click:{x:px,y:py} }, [imgData.data.buffer]);
    });
  }

  // Robust axis-aligned extension from click: tries horizontal and vertical, picks longer
  _extendFromClick(world, prefer){
    const p=this.state.page; if(!p) return null; const src = p.processedCanvas || p.cvCanvas || this._sourceCanvas(); if(!src) return null;
    const w=src.width, h=src.height; const ctx=src.getContext('2d');
    const clamp=(v,a,b)=>v<a?a:v>b?b:v; const cx=clamp(Math.round(world.x),0,w-1), cy=clamp(Math.round(world.y),0,h-1);
    const localStats=()=>{ const win=80; const xL=clamp(cx-win,0,w-1), xR=clamp(cx+win,0,w-1), yT=clamp(cy-win,0,h-1), yB=clamp(cy+win,0,h-1); const patch=ctx.getImageData(xL,yT,xR-xL+1,yB-yT+1).data; let sum=0,c=0; for(let i=0;i<patch.length;i+=4){ const r=patch[i],g=patch[i+1],b=patch[i+2]; sum+=0.2126*r+0.7152*g+0.0722*b; c++; } const bg=sum/Math.max(1,c); return {bg, preferDark:bg>140, darkThr:Math.max(0,Math.min(255,bg-40)), brightThr:Math.max(0,Math.min(255,bg+40))} };
    const {preferDark,darkThr,brightThr} = localStats();
    const isLinePix=(l)=> preferDark ? (l<=darkThr):(l>=brightThr);
    const getLum=(x,y)=>{ const u=ctx.getImageData(x,y,1,1).data; return (0.2126*u[0]+0.7152*u[1]+0.0722*u[2])|0 };
    const stopAt = this.hlStop ? !!this.hlStop.checked : true;
    function extend(orient){
      const maxC=16; const maxStep=Math.max(w,h); let posX=cx, posY=cy;
      const crossWidthAt=(x,y)=>{ let run=0,best=0,center=0,cur=0,curStart=-1; for(let k=-maxC;k<=maxC;k++){ const xx=orient==='h'?clamp(x+k,0,w-1):x; const yy=orient==='h'?y:clamp(y+k,0,h-1); const l=getLum(xx,yy); const on=isLinePix(l); if(on){ if(cur===0){curStart=k} cur++; if(cur>best){best=cur; center=Math.round((curStart+k)/2)} } else { cur=0 } } return {width:best, centerOffset:center}; };
      let cw = crossWidthAt(posX,posY); if(orient==='h') posY=clamp(posY+cw.centerOffset,0,h-1); else posX=clamp(posX+cw.centerOffset,0,w-1);
      const juncSens = +(this.hlJunc?.value||60); const extendBias=+(this.hlExtend?.value||50);
      const baseWidth=Math.max(1,cw.width); const widenStop = stopAt ? Math.max(Math.round(baseWidth*1.8), baseWidth+3) : Number.POSITIVE_INFINITY; const shrinkStop=Math.max(1,Math.round(baseWidth*0.5)); const minStopSteps=Math.max(4,Math.round(baseWidth*(1 + extendBias/50))); const missMax=Math.max(3, Math.round(2 + extendBias/5));
      const hasPerpBranch=(x,y)=>{
        if(!stopAt) return false; const reach=12, near=2; let best=0; if(orient==='h'){ for(let dx=-near; dx<=near; dx++){ const xx=clamp(x+dx,0,w-1); let run=0; for(let dy=-reach; dy<=reach; dy++){ const yy=clamp(y+dy,0,h-1); const l=getLum(xx,yy); if(isLinePix(l)){ run++; best=Math.max(best,run) } else { run=0 } } } } else { for(let dy=-near; dy<=near; dy++){ const yy=clamp(y+dy,0,h-1); let run=0; for(let dx=-reach; dx<=reach; dx++){ const xx=clamp(x+dx,0,w-1); const l=getLum(xx,yy); if(isLinePix(l)){ run++; best=Math.max(best,run) } else { run=0 } } } } return best>=8; };
      function walk(dir){ let x=posX,y=posY,miss=0,steps=0,lastX=x,lastY=y; while(steps++<maxStep){ if(orient==='h'){ x+=dir; if(x<0||x>=w) break; const m=crossWidthAt(x,y); if(m.width>=shrinkStop){ lastX=x; lastY=y; if(steps>minStopSteps && (m.width>=widenStop || hasPerpBranch(x,y))){ break } miss=0 } else { if(++miss>missMax) break } } else { y+=dir; if(y<0||y>=h) break; const m=crossWidthAt(x,y); if(m.width>=shrinkStop){ lastX=x; lastY=y; if(steps>minStopSteps && (m.width>=widenStop || hasPerpBranch(x,y))){ break } miss=0 } else { if(++miss>missMax) break } } } return {x:lastX,y:lastY,width:baseWidth}; }
      const a=walk(-1), b=walk(1); const len = orient==='h'? Math.abs(b.x-a.x) : Math.abs(b.y-a.y); return { seg: orient==='h'?{x1:a.x,y1:a.y,x2:b.x,y2:b.y,kind:'h'}:{x1:a.x,y1:a.y,x2:b.x,y2:b.y,kind:'v'}, len, width:Math.max(4, Math.round(baseWidth*2.2)) };
    }
    const H=extend('h'), V=extend('v');
    // Prefer explicit axis if provided
    let pick = prefer==='h'?H : prefer==='v'?V : (H.len>=V.len?H:V);
    // Require a reasonable minimum length
    const minLen = Math.max(24, Math.round(Math.max(H.width,V.width)*6));
    if(pick.len < minLen && (Math.max(H.len,V.len) < minLen)){
      // both short -> reject (caller may fall back to CV or ignore)
      return null;
    }
    // If lengths are close but one is clearly axis-aligned longer, keep it
    if(!prefer && Math.abs(H.len - V.len) < 12){ pick = (H.len>=V.len?H:V) }
    return {...pick.seg, width:pick.width};
  }

  // Extend a detected segment along its axis until a junction dot/symbol or gap is detected.
  _extendLineFromSeed(seg, world){
    const p=this.state.page; if(!p) return null; const src = p.processedCanvas || p.cvCanvas || this._sourceCanvas(); if(!src) return null;
    const w=src.width, h=src.height; const ctx=src.getContext('2d');
    // Determine orientation from seg
    const dx=Math.abs(seg.x2-seg.x1), dy=Math.abs(seg.y2-seg.y1);
    const orient = (dx>=dy)?'h':'v';
    const clamp=(v,a,b)=>v<a?a:v>b?b:v;
    const cx = clamp(Math.round(world.x), 0, w-1); const cy = clamp(Math.round(world.y), 0, h-1);
    // Compute local brightness profile and thresholds
    const win = 80; const xL = clamp(cx-win,0,w-1), xR=clamp(cx+win,0,w-1); const yT=clamp(cy-win,0,h-1), yB=clamp(cy+win,0,h-1);
    const patch = ctx.getImageData(xL, yT, xR-xL+1, yB-yT+1).data; let sum=0,cnt=0; for(let i=0;i<patch.length;i+=4){ const r=patch[i],g=patch[i+1],b=patch[i+2]; sum+=0.2126*r+0.7152*g+0.0722*b; cnt++; }
    const bg=sum/Math.max(1,cnt); const preferDark = bg>140; const darkThr=Math.max(0,Math.min(255,bg-40)); const brightThr=Math.max(0,Math.min(255,bg+40));
    const isLinePix=(l)=> preferDark ? (l<=darkThr):(l>=brightThr);
    const getLum=(x,y)=>{ const id=ctx.getImageData(x,y,1,1).data; return (0.2126*id[0]+0.7152*id[1]+0.0722*id[2])|0 };
    // Detect a perpendicular branch (junction) near the current axis point
    const hasPerpBranch=(x,y)=>{
      if(!stopAt) return false;
      const reach = 12; const near=2; let bestRun=0;
      if(orient==='h'){
        for(let dx=-near; dx<=near; dx++){
          const xx = clamp(x+dx,0,w-1);
          // scan vertical up/down from y, looking for a contiguous run
          let run=0; for(let dy=-reach; dy<=reach; dy++){
            const yy = clamp(y+dy,0,h-1); const l=getLum(xx,yy); if(isLinePix(l)){ run++; bestRun=Math.max(bestRun,run) } else { run=0 }
          }
        }
      }else{
        for(let dy=-near; dy<=near; dy++){
          const yy = clamp(y+dy,0,h-1);
          let run=0; for(let dx=-reach; dx<=reach; dx++){
            const xx = clamp(x+dx,0,w-1); const l=getLum(xx,yy); if(isLinePix(l)){ run++; bestRun=Math.max(bestRun,run) } else { run=0 }
          }
        }
      }
      return bestRun>=8; // tuned length to qualify as a branch
    };
    const crossWidthAt=(x,y)=>{
      const maxC=16; let run=0,best=0,centerPos=0; let cur=0,curStart=-1;
      for(let k=-maxC;k<=maxC;k++){
        const xx = orient==='h'? clamp(x+k,0,w-1): x;
        const yy = orient==='h'? y: clamp(y+k,0,h-1);
        const l = getLum(xx,yy);
        const on = isLinePix(l);
        if(on){ if(cur===0){curStart=k;} cur++; if(cur>best){best=cur; centerPos=Math.round((curStart + k)/2)} }
        else { cur=0 }
      }
      return { width:best, centerOffset:centerPos };
    };
    // Align to center of stroke locally
    let posX=cx, posY=cy; const cw = crossWidthAt(posX,posY); if(orient==='h'){ posY = clamp(posY+cw.centerOffset,0,h-1) } else { posX = clamp(posX+cw.centerOffset,0,w-1) }
    const baseWidth = Math.max(1, cw.width);
    const stopAt = this.hlStop ? !!this.hlStop.checked : true;
    const juncSens = +(this.hlJunc?.value||60); // 0..100
    const extendBias = +(this.hlExtend?.value||50); // 0..100
    let widenStop = Math.max( Math.round(baseWidth*1.8), baseWidth+3 );
    if(!stopAt){ widenStop = Number.POSITIVE_INFINITY }
    const minStopSteps = Math.max(4, Math.round(baseWidth*(1 + extendBias/50)));
    const missMax = Math.max(3, Math.round(2 + extendBias/5));
    const shrinkStop = Math.max(1, Math.round(baseWidth*0.5));
    const stepLimit = Math.max(w,h);
      function walk(dir){
        let x=posX, y=posY; let misses=0; let steps=0; let lastGoodX=x, lastGoodY=y;
        while(steps++<stepLimit){
        if(orient==='h'){
          x += dir; if(x<0||x>=w) break; const m=crossWidthAt(x,y);
          if(m.width>=shrinkStop){ lastGoodX=x; lastGoodY=y; if(steps>minStopSteps && (m.width>=widenStop || hasPerpBranch(x,y))){ break } misses=0 } else { if(++misses>missMax) break }
        } else {
          y += dir; if(y<0||y>=h) break; const m=crossWidthAt(x,y);
          if(m.width>=shrinkStop){ lastGoodX=x; lastGoodY=y; if(steps>minStopSteps && (m.width>=widenStop || hasPerpBranch(x,y))){ break } misses=0 } else { if(++misses>missMax) break }
        }
        }
        return {x:lastGoodX, y:lastGoodY};
      }
    const a = walk(-1), b = walk(1);
    const drawW = Math.max(4, Math.round(baseWidth*2.2));
    if(orient==='h'){ return { x1:a.x, y1:a.y, x2:b.x, y2:b.y, kind:'h', width:drawW } } else { return { x1:a.x, y1:a.y, x2:b.x, y2:b.y, kind:'v', width:drawW } }
  }
  _previewTwoPoint(a,b){
    const o=this.viewer.octx; this._clearPreview(); o.save(); o.strokeStyle='#ffffff88'; o.setLineDash([4,4]);
    const p1=this.viewer.worldToScreen(a.x,a.y), p2=this.viewer.worldToScreen(b.x,b.y);
    if(this.tool==='rect'){ const x=Math.min(p1.x,p2.x), y=Math.min(p1.y,p2.y), w=Math.abs(p1.x-p2.x), h=Math.abs(p1.y-p2.y); o.strokeRect(x,y,w,h) }
    if(this.tool==='arrow'||this.tool==='measure'){ o.beginPath(); o.moveTo(p1.x,p1.y); o.lineTo(p2.x,p2.y); o.stroke() }
    o.restore();
  }
  _clearPreview(){ /* redraw full overlay */ this.viewer.requestRender(); }
  _hotkeys(e){
    if(e.target.matches('input, textarea')) return;
    const v=this.viewer;
    if(e.key===' '){ e.preventDefault(); this.tool='pan'; this._syncToolButtons(); return }
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='o'){ e.preventDefault(); this.fileInput.click(); return }
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){ e.preventDefault(); this._exportProject(); return }
    if(e.key==='+'){ v.zoomAt(1.2, v.w/2, v.h/2); return }
    if(e.key==='-'){ v.zoomAt(1/1.2, v.w/2, v.h/2); return }
    if(e.key==='0'){ v.fit(); return }
    if(e.key==='1'){ this.tool='pan'; this._syncToolButtons(); return }
    if(e.key==='2'){ this.tool='rect'; this._syncToolButtons(); return }
    if(e.key==='3'){ this.tool='arrow'; this._syncToolButtons(); return }
    if(e.key==='4'){ this.tool='text'; this._syncToolButtons(); return }
    if(e.key==='5'){ this.tool='measure'; this._syncToolButtons(); return }
    if(e.key==='6'){ this.tool='highlight'; this._syncToolButtons(); return }
  }
  async _exportProject(){
    const proj = { version:2, pages:[] };
    for(const p of this.state.pages){
      // original image
      const c = document.createElement('canvas'); c.width=p.bitmap.width; c.height=p.bitmap.height; const ctx=c.getContext('2d'); ctx.drawImage(p.bitmap,0,0);
      const dataUrl = c.toDataURL('image/png');
      // opencv base if any
      let cvUrl = null; if(p.cvCanvas){ cvUrl = p.cvCanvas.toDataURL('image/png') }
      proj.pages.push({ name:p.name, image:dataUrl, imageCv:cvUrl, enhance:p.enhance, layers:p.layers, activeLayerId:p.activeLayerId, annotations:p.annotations, scale:p.scale });
    }
    const blob = new Blob([JSON.stringify(proj)], {type:'application/json'});
    const url = await toDataURL(blob); download(`schematic-project.json`, url);
    this._saveLastSession(proj).catch(console.warn);
  }
  async _loadProject(proj){
    if(proj?.version!==2 || !Array.isArray(proj.pages)) throw new Error('Invalid project file');
    // Reset state
    this.state.pages = []; this.state.current = -1;
    for(const pg of proj.pages){
      const resp = await fetch(pg.image); const blob = await resp.blob(); const bmp = await createImageBitmap(blob);
      const p = this.state.addPage(pg.name||'Page', bmp);
      p.enhance = pg.enhance||p.enhance; p.layers=pg.layers||p.layers; p.annotations=pg.annotations||[]; p.scale=pg.scale||p.scale; p.activeLayerId = pg.activeLayerId || (p.layers[0]&&p.layers[0].id) || 'default';
      // map orphan annotations to first layer
      const ids = new Set(p.layers.map(l=>l.id)); p.annotations.forEach(a=>{ if(!ids.has(a.layerId)) a.layerId=p.activeLayerId });
      p.thumbDataUrl = await this._bitmapToThumb(bmp);
      if(pg.imageCv){ const cvResp = await fetch(pg.imageCv); const cvBlob = await cvResp.blob(); const cvBmp = await createImageBitmap(cvBlob); const c = document.createElement('canvas'); c.width=cvBmp.width; c.height=cvBmp.height; c.getContext('2d').drawImage(cvBmp,0,0); p.cvCanvas=c; }
      await this._applyEnhancements(p);
    }
    this.state.setCurrent(0);
    this._queueAutosave();
    this._toast('Project loaded', 'ok');
  }
  _setupAutosave(){
    this._autosaveTimer=null; this._autosaveDebounce=()=>{ clearTimeout(this._autosaveTimer); this._autosaveTimer=setTimeout(()=>this._doAutosave(), 800) };
    this._queueAutosave=()=>this._autosaveDebounce();
    window.addEventListener('beforeunload', ()=>this._doAutosave());
    // Try load last session
    try{
      const hash = (location.hash||'');
      if(hash.includes('clean') || hash.includes('noresume')){
        this._debug('resume:skipped', { reason: 'hash' });
      } else {
        this._loadLastSession().catch(()=>{});
      }
    }catch(_){ }
  }
  async _doAutosave(){
    const proj = await this._projectSnapshot();
    await this._saveLastSession(proj);
  }
  async _projectSnapshot(){
    const proj = { version:2, pages:[] };
    for(const p of this.state.pages){
      const c = document.createElement('canvas'); c.width=p.bitmap.width; c.height=p.bitmap.height; const ctx=c.getContext('2d'); ctx.drawImage(p.bitmap,0,0);
      const dataUrl = c.toDataURL('image/png');
      proj.pages.push({ name:p.name, image:dataUrl, enhance:p.enhance, layers:p.layers, annotations:p.annotations, scale:p.scale });
    }
    return proj;
  }
  async _saveLastSession(obj){
    const db = await openDB('schematic-studio', 1, (db)=>{ if(!db.objectStoreNames.contains('kv')) db.createObjectStore('kv') });
    const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put(obj,'last'); await tx.done;
  }
  async _loadLastSession(){
    const db = await openDB('schematic-studio', 1, (db)=>{ if(!db.objectStoreNames.contains('kv')) db.createObjectStore('kv') });
    const tx = db.transaction('kv'); const os = tx.objectStore('kv'); const obj = await idbReq(os.get('last')); await tx.done;
    if(obj && obj.pages?.length){ await this._loadProject(obj) }
  }
}

// Boot once DOM is ready
document.addEventListener('DOMContentLoaded', ()=>{
  const app = new AppUI();
});

// Tiny IndexedDB helper (no external deps)
function openDB(name, version, upgrade){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (e)=>upgrade && upgrade(req.result, e.oldVersion, e.newVersion);
    req.onerror = ()=>reject(req.error);
    req.onsuccess = ()=>{
      const idb = req.result;
      const nativeTx = idb.transaction.bind(idb);
      resolve({
        transaction(store,mode='readonly'){
          const tx = nativeTx(store, mode);
          return {
            objectStore(name){ return tx.objectStore(name||store) },
            get done(){ return new Promise((res,rej)=>{ tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error) }) }
          }
        },
        close(){ try{idb.close()}catch(_){} }
      });
    }
  });
}

function idbReq(req){ return new Promise((res,rej)=>{ req.onsuccess=()=>res(req.result); req.onerror=()=>rej(req.error) }) }

// Toast helper
AppUI.prototype._setupToast = function(){ this.toast = document.getElementById('toast') }
AppUI.prototype._toast = function(msg, kind='ok'){ if(!this.toast) return; this.toast.className = `toast show ${kind==='error'?'error':'ok'}`; this.toast.textContent = msg; clearTimeout(this._toastTimer); this._toastTimer = setTimeout(()=>{ this.toast.classList.remove('show') }, 2500) }

// OpenCV loader
function loadOpenCV(button){
  // Spawn a worker that loads OpenCV off the main thread. Resolves when ready.
  return new Promise((resolve, reject)=>{
    // File protocol caveat: loading opencv.js from HTTPS inside a worker
    // is blocked in some browsers when the page is served via file://.
    // In that case, guide the user to run from http(s).
    try{
      if(location.protocol==='file:'){
        console.warn('OpenCV load blocked under file: protocol. Serve over http(s).');
        const err = new Error('OpenCV requires http(s) context');
        // Friendly toast if available
        try{ (window.__appUIInstance?._toast||(()=>{}))('OpenCV requires http(s). Open docs/ via http://localhost', 'error') }catch(_){ }
        reject(err); return;
      }
    }catch(_){ }
    if(window.cvWorker && window.cvWorkerReady){ resolve('worker'); return }
    const prevTxt = button?button.textContent:''; if(button){ button.disabled=true; button.textContent='Loading…' }
    try{
      const w = new Worker('cv-worker.js');
      w.onmessage = (ev)=>{
        const d=ev.data||{};
        if(d.type==='ready'){
          window.cvWorker = w; window.cvWorkerReady = true;
          if(button){ button.disabled=false; button.textContent=prevTxt }
          resolve('worker');
        } else if(d.type==='error'){
          if(button){ button.disabled=false; button.textContent=prevTxt }
          reject(new Error(d.error||'Worker error'));
        }
      };
      w.onerror = (e)=>{ if(button){ button.disabled=false; button.textContent=prevTxt } reject(new Error(e.message||'Worker failed')) };
      w.postMessage({type:'init'});
    }catch(e){ if(button){ button.disabled=false; button.textContent=prevTxt } reject(e) }
  });
}

// OpenCV operations
AppUI.prototype._sourceCanvas = function(){ const p=this.state.page; if(!p) return null; if(p.cvCanvas) return p.cvCanvas; const c=document.createElement('canvas'); c.width=p.bitmap.width; c.height=p.bitmap.height; c.getContext('2d').drawImage(p.bitmap,0,0); return c };

  AppUI.prototype._cvDeskew = function(){
  const p=this.state.page; if(!p) return; const c=this._sourceCanvas(); if(!c) return;
  const ctx=c.getContext('2d'); const img=ctx.getImageData(0,0,c.width,c.height);
  if(!(window.cvWorker && window.cvWorkerReady)){ this._toast('Load OpenCV first', 'error'); return }
  const w=window.cvWorker; const onMsg=(ev)=>{
    const d=ev.data||{}; if(d.type==='deskew:result'){
      w.removeEventListener('message', onMsg);
      const out=d.image; const outCanvas=document.createElement('canvas'); outCanvas.width=out.width; outCanvas.height=out.height; outCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(out.data), out.width, out.height),0,0);
      p.cvCanvas=outCanvas; this._applyEnhancements(p);
    }
  };
  w.addEventListener('message', onMsg);
  w.postMessage({ type:'deskew', image:{ data:img.data.buffer, width:c.width, height:c.height } }, [img.data.buffer]);
}

  AppUI.prototype._cvDenoise = function(){
  const p=this.state.page; if(!p) return; const c=this._sourceCanvas(); if(!c) return;
  const ctx=c.getContext('2d'); const img=ctx.getImageData(0,0,c.width,c.height);
  if(!(window.cvWorker && window.cvWorkerReady)){ this._toast('Load OpenCV first', 'error'); return }
  const w=window.cvWorker; const onMsg=(ev)=>{
    const d=ev.data||{}; if(d.type==='denoise:result'){
      w.removeEventListener('message', onMsg);
      const out=d.image; const outCanvas=document.createElement('canvas'); outCanvas.width=out.width; outCanvas.height=out.height; outCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(out.data), out.width, out.height),0,0);
      p.cvCanvas=outCanvas; this._applyEnhancements(p);
    }
  };
  w.addEventListener('message', onMsg);
  w.postMessage({ type:'denoise', image:{ data:img.data.buffer, width:c.width, height:c.height } }, [img.data.buffer]);
}

  AppUI.prototype._cvAdaptive = function(){
  const p=this.state.page; if(!p) return; const c=this._sourceCanvas(); if(!c) return;
  const ctx=c.getContext('2d'); const img=ctx.getImageData(0,0,c.width,c.height);
  if(!(window.cvWorker && window.cvWorkerReady)){ this._toast('Load OpenCV first', 'error'); return }
  const w=window.cvWorker; const onMsg=(ev)=>{
    const d=ev.data||{}; if(d.type==='adaptive:result'){
      w.removeEventListener('message', onMsg);
      const out=d.image; const outCanvas=document.createElement('canvas'); outCanvas.width=out.width; outCanvas.height=out.height; outCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(out.data), out.width, out.height),0,0);
      p.cvCanvas=outCanvas; this._applyEnhancements(p);
    }
  };
  w.addEventListener('message', onMsg);
  w.postMessage({ type:'adaptive', image:{ data:img.data.buffer, width:c.width, height:c.height } }, [img.data.buffer]);
}
