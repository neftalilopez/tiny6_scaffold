/*!
 * scaffold.js v2 — in-browser video size reduction
 * Plain <script> library. Global: Scaffold
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES
 * ---------------------------------------------------------------------------
 * Re-encodes video with ffmpeg.wasm to make it smaller. This is LOSSY — the
 * saving comes from re-compressing pixels, not from repacking the existing
 * bitstream. Lossless recompression of an already-encoded mp4/webm/mkv is not
 * possible in any useful amount; general compressors return ~100% of input.
 *
 * Two modes:
 *   mode:'crf'    — you pick a quality level, you get whatever size results.
 *   mode:'target' — you name a size, it FINDS the CRF that lands there by
 *                   encoding short samples and projecting. Every +6 CRF is
 *                   roughly half the size, which is what makes the search
 *                   converge in 2-3 samples.
 *
 * Targeting is projected from a sample taken 40% into the video, never from
 * the opening seconds (titles and fades are not representative), and the
 * projection always divides by the FULL duration. Reported reduction is
 * always measured against the original input file size.
 *
 * ---------------------------------------------------------------------------
 * LARGE FILES
 * ---------------------------------------------------------------------------
 * Input is mounted via WORKERFS, so the source is read lazily from the Blob
 * and never copied into the wasm heap. That is what makes 250-350 MB inputs
 * viable in a 32-bit wasm address space. Output stays in MEMFS, which is fine
 * because output is small by design. If mounting is unavailable the library
 * falls back to writeFile and warns that large inputs may exhaust memory.
 *
 * ---------------------------------------------------------------------------
 * CODEC REALITY
 * ---------------------------------------------------------------------------
 * The stock ffmpeg.wasm core has libx264 and libvpx (VP8/VP9). It does NOT
 * have x265, SVT-AV1 or AOM-AV1 — those exist in native ffmpeg builds only.
 * So savings here come from CRF, resolution and audio budget, not from a
 * codec-generation jump. capabilities() reports what your core actually has
 * rather than assuming.
 *
 * Speed: roughly 5-20x slower than native ffmpeg. The multithreaded core is
 * several times faster but needs COOP/COEP headers; single-thread works
 * anywhere. Detected automatically.
 *
 * Dependencies (load first):
 *   <script src="https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js"></script>
 *   <script src="https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js"></script>
 *
 * License: MIT
 */
(function (global) {
  'use strict';

  var CORE_ST = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
  var CORE_MT = 'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/umd';

  // Realistic reduction by source codec, at roughly comparable quality.
  var SOURCE_PROFILES = {
    h263:{t:'legacy',r:0.65,l:'H.263'},         flv1:{t:'legacy',r:0.65,l:'Sorenson Spark'},
    vp6:{t:'legacy',r:0.60,l:'VP6'},            vp6f:{t:'legacy',r:0.60,l:'VP6-F'},
    svq3:{t:'legacy',r:0.60,l:'Sorenson SVQ3'}, mpeg4:{t:'legacy',r:0.50,l:'MPEG-4 ASP'},
    msmpeg4v3:{t:'legacy',r:0.50,l:'MS MPEG-4 v3'}, mpeg2video:{t:'legacy',r:0.60,l:'MPEG-2'},
    mpeg1video:{t:'legacy',r:0.60,l:'MPEG-1'},  wmv2:{t:'legacy',r:0.50,l:'WMV2'},
    wmv3:{t:'legacy',r:0.50,l:'WMV3'},          theora:{t:'legacy',r:0.45,l:'Theora'},
    h264:{t:'current',r:0.32,l:'H.264'},        vp8:{t:'current',r:0.32,l:'VP8'},
    vp9:{t:'modern',r:0.12,l:'VP9'},            hevc:{t:'modern',r:0.12,l:'H.265'},
    av1:{t:'modern',r:0.02,l:'AV1'}
  };

  // Standard downscale ladder, largest first.
  var LADDER = [
    { h:2160 }, { h:1440 }, { h:1080 }, { h:720 }, { h:480 }, { h:360 }, { h:240 }
  ];

  // ---------------- Tiny6 container ----------------
  // A .ts6/.tn6 file is a 128-byte little-endian header followed by a plain
  // WebM payload. Everything below was read off a real sample, not guessed.
  //
  //   0x00  4  magic "TS6V"        0x1C  4  audio sample rate
  //   0x04  1  version major       0x20  1  audio channels
  //   0x05  1  version minor       0x21  4  audio rate (repeat)
  //   0x06  2  header size (128)   0x28  8  video codec, ascii
  //   0x08  4  payload byte count  0x30  8  audio codec, ascii
  //   0x0C  2  coded width         0x38 16  mime, ascii
  //   0x0E  2  coded height        0x50  8  source container, ascii
  //   0x10  2  max width  (800)    0x58 32  title, ascii
  //   0x12  2  max height (600)    0x78  8  header size (repeat)
  //   0x14  4  fps numerator
  //   0x18  4  fps denominator
  //
  // Output geometry: coded 512x384 with sample aspect 4:3, which players
  // display as 683x384. Coding 196,608 pixels to show 262,272 is the whole
  // point of the anamorphic trick — and 683 is odd, so it could never be a
  // coded width in yuv420p anyway.
  var Tiny6 = {
    MAGIC: [0x54,0x53,0x36,0x56],   // "TS6V"
    HEADER_SIZE: 128,
    CODED_W: 512, CODED_H: 384,
    DISPLAY_W: 683, DISPLAY_H: 384,
    MAX_W: 800, MAX_H: 600,
    EXT: 'tn6',

    isTiny6: function(u8){
      return u8 && u8.length>=4 && u8[0]===0x54 && u8[1]===0x53 && u8[2]===0x36 && u8[3]===0x56;
    },

    parseHeader: function(u8){
      if(!Tiny6.isTiny6(u8)) return null;
      var dv = new DataView(u8.buffer, u8.byteOffset, Math.min(u8.byteLength,128));
      function str(off,len){
        var out='';
        for(var i=0;i<len;i++){ var c=u8[off+i]; if(!c) break; out+=String.fromCharCode(c); }
        return out;
      }
      var den = dv.getUint32(24,true) || 1;
      return {
        versionMajor: u8[4], versionMinor: u8[5],
        headerSize: dv.getUint16(6,true) || 128,
        payloadBytes: dv.getUint32(8,true),
        width: dv.getUint16(12,true), height: dv.getUint16(14,true),
        maxWidth: dv.getUint16(16,true), maxHeight: dv.getUint16(18,true),
        fpsNum: dv.getUint32(20,true), fpsDen: den,
        fps: dv.getUint32(20,true)/den,
        sampleRate: dv.getUint32(28,true), channels: u8[32],
        videoCodec: str(40,8), audioCodec: str(48,8),
        mime: str(56,16), sourceFormat: str(80,8), title: str(88,32)
      };
    },

    buildHeader: function(m){
      var h = new Uint8Array(128);
      var dv = new DataView(h.buffer);
      h[0]=0x54; h[1]=0x53; h[2]=0x36; h[3]=0x56;
      h[4]=m.versionMajor||1; h[5]=m.versionMinor||1;
      dv.setUint16(6,128,true);
      dv.setUint32(8,m.payloadBytes>>>0,true);
      dv.setUint16(12,m.width||Tiny6.CODED_W,true);
      dv.setUint16(14,m.height||Tiny6.CODED_H,true);
      dv.setUint16(16,m.maxWidth||Tiny6.MAX_W,true);
      dv.setUint16(18,m.maxHeight||Tiny6.MAX_H,true);
      dv.setUint32(20,m.fpsNum||24000,true);
      dv.setUint32(24,m.fpsDen||1001,true);
      dv.setUint32(28,m.sampleRate||48000,true);
      h[32]=m.channels||2;
      // Offset 33 is the AUDIO BITRATE. It previously repeated the sample rate
      // from offset 28, so players reading this field reported 48000 kbps.
      dv.setUint32(33,(m.audioKbps||0)*1000,true);
      function put(off,len,txt){
        txt=String(txt||'');
        for(var i=0;i<len;i++) h[off+i] = i<txt.length ? (txt.charCodeAt(i)&0x7F) : 0;
      }
      put(40,8,(m.videoCodec||'VP9').toUpperCase());
      put(48,8,(m.audioCodec||'OPUS').toUpperCase());
      put(56,16,m.mime||'video/webm');
      put(80,8,(m.sourceFormat||'').toUpperCase());
      put(88,32,m.title||'');
      dv.setUint32(120,128,true);
      return h;
    },

    // Letterbox in display space, then squeeze horizontally and set the
    // sample aspect. force_divisible_by=2 matters: 683x384 is not exactly
    // 16:9, so a 16:9 source otherwise rounds past 384 and pad rejects it.
    filterChain: function(){
      return 'scale='+Tiny6.DISPLAY_W+':'+Tiny6.DISPLAY_H+
             ':force_original_aspect_ratio=decrease:force_divisible_by=2,'+
             'pad='+Tiny6.DISPLAY_W+':'+Tiny6.DISPLAY_H+':(ow-iw)/2:(oh-ih)/2:color=black,'+
             'scale='+Tiny6.CODED_W+':'+Tiny6.CODED_H+',setsar=4/3';
    },

    // Title field is 32 bytes of ascii.
    makeTitle: function(name){
      return String(name||'video').replace(/\.[A-Za-z0-9]+$/,'')
             .replace(/[^\x20-\x7E]/g,'_').slice(0,32);
    }
  };

  var DEFAULTS = {
    tiny6: false,          // true -> 683x384 anamorphic output wrapped as .tn6
    mode: 'target',        // 'target' | 'crf'
    targetMB: 8,           // target mode: desired output size
    crf: 32,               // crf mode: 18(big/great) .. 45(small/rough)
    codec: 'auto',         // 'auto' | 'h264' | 'vp9'
    maxHeight: 'auto',     // 'auto' | 0 (keep) | 240/360/480/720/1080
    audioKbps: 'auto',     // 'auto' | number | 'none'
    audioChannels: 'auto', // 'auto' | 1 | 2
    preset: 'veryfast',    // x264 preset — wasm is slow, veryfast is sane
    sampleSeconds: 8,      // length of each probe encode
    maxIterations: 3,      // CRF search attempts
    tolerance: 0.10,       // accept within +/-10% of target
    luma: 1.0,             // Y-plane scale. 1.0 = off. 0.70..1.00.
    lumaMode: 'safe',      // 'safe' keeps black at 16; 'raw' is val*L (Luma Crush)
    verify: false,         // measure SSIM (roughly doubles runtime)
    execTimeoutMs: 0,      // 0 = no timeout; else abort a stuck ffmpeg call
    onProgress: null,      // fn({stage,percent,message})
    onLog: null            // fn(line)
  };

  var MAX_SAFE_BYTES = 350 * 1024 * 1024;

  // ---------------- helpers ----------------
  function clamp(n,a,b){ return n<a?a:(n>b?b:n); }

  /**
   * Y-plane scaling. Reduces luma amplitude so residuals quantise to zero
   * more often. It is a real saving on some content and a real loss on
   * others -- measure before trusting it.
   *
   * 'safe' scales about the limited-range black point, so 16 stays 16 and
   * shadow detail is not pushed below the legal floor. 'raw' reproduces
   * Luma Crush's val*L, which drags black under 16 and clips it.
   *
   * Commas inside a filter argument must be escaped or lavfi reads them as
   * filter separators.
   */
  function lumaFilter(L, mode){
    if(!(L<1)) return null;
    if(mode==='raw') return 'lutyuv=y=clip(val*'+L+'\\,0\\,255)';
    return 'lutyuv=y=clip((val-16)*'+L+'+16\\,16\\,235)';
  }

  /** Inverse of the above, for measuring detail loss apart from brightness. */
  function lumaUnfilter(L, mode){
    if(!(L<1)) return null;
    if(mode==='raw') return 'lutyuv=y=clip(val/'+L+'\\,0\\,255)';
    return 'lutyuv=y=clip((val-16)/'+L+'+16\\,16\\,235)';
  }
  function fmtBytes(n){
    if(n>=1073741824) return (n/1073741824).toFixed(2)+' GB';
    if(n>=1048576) return (n/1048576).toFixed(2)+' MB';
    if(n>=1024) return (n/1024).toFixed(1)+' KB';
    return (n|0)+' B';
  }
  function extOf(n){ var m=/\.([A-Za-z0-9]+)$/.exec(n||''); return m?m[1].toLowerCase():''; }
  function baseOf(n){ return (n||'video').replace(/\.[A-Za-z0-9]+$/,''); }
  function ffCtor(){
    if(global.FFmpegWASM && global.FFmpegWASM.FFmpeg) return global.FFmpegWASM.FFmpeg;
    if(global.FFmpeg && global.FFmpeg.FFmpeg) return global.FFmpeg.FFmpeg;
    return null;
  }
  // Core files are cached per URL so a second load() is instant.
  var _blobCache = {};

  /**
   * ffmpeg.wasm builds a Worker from coreURL. A browser will not construct a
   * worker from a cross-origin script, and COEP:require-corp blocks the plain
   * fetch too, so the CDN URL has to become a same-origin blob: URL first.
   * Doing the fetch by hand (rather than via FFmpegUtil.toBlobURL) lets us
   * report progress -- the mt core is ~32 MB and silence looks like a hang.
   */
  function fetchToBlobURL(url, mime, onProg){
    if(_blobCache[url]) return Promise.resolve(_blobCache[url]);
    return fetch(url, { mode:'cors', credentials:'omit' }).then(function(r){
      if(!r.ok) throw new Error('HTTP '+r.status+' fetching '+url);
      var total = +(r.headers.get('content-length')||0);
      if(!r.body || !r.body.getReader) return r.blob();      // no streaming: take it whole
      var reader = r.body.getReader(), chunks = [], got = 0;
      return (function pump(){
        return reader.read().then(function(res){
          if(res.done) return new Blob(chunks, { type:mime });
          chunks.push(res.value); got += res.value.length;
          if(onProg) onProg(got, total);
          return pump();
        });
      })();
    }).then(function(blob){
      var u = URL.createObjectURL(new Blob([blob], { type:mime }));
      _blobCache[url] = u;
      return u;
    });
  }

  /**
   * Same-origin URLs must be passed through untouched. Converting them to
   * blob: breaks relative resolution inside the worker chunk, which then
   * fails with a bare event rather than an Error -- hence "(undefined)".
   */
  /**
   * Resolve to an absolute URL against the page.
   *
   * This is not optional. The published @ffmpeg/ffmpeg UMD bundle has its
   * build-time import.meta.url baked in -- literally the author's machine,
   * file:///home/jeromewu/ffmpeg.wasm/... A relative path handed to the
   * library is resolved against THAT, not against your page, and the worker
   * construction then fails on a file:// URL that never existed here.
   */
  function absURL(url){
    try{ return new URL(url, global.location.href).href; }
    catch(e){ return url; }
  }

  function sameOrigin(url){
    try{
      if(/^blob:|^data:/.test(url)) return true;
      return new URL(url, global.location.href).origin === global.location.origin;
    }catch(e){ return true; }
  }

  function mtSupported(){
    return typeof SharedArrayBuffer !== 'undefined' &&
           (typeof crossOriginIsolated === 'undefined' || crossOriginIsolated === true);
  }

  function parseProbe(log){
    var i = { durationSec:0, videoCodec:null, audioCodec:null, width:0, height:0,
              fps:0, totalKbps:0, audioKbps:0, hasAudio:false, rotated:false };
    var d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
    if(d) i.durationSec = (+d[1])*3600 + (+d[2])*60 + parseFloat(d[3]);
    var b = /Duration:[^\n]*bitrate:\s*(\d+)\s*kb\/s/.exec(log);
    if(b) i.totalKbps = +b[1];
    var v = /Stream #\d+:\d+[^\n]*?:\s*Video:\s*([A-Za-z0-9_]+)[^\n]*/.exec(log);
    if(v){
      i.videoCodec = v[1].toLowerCase();
      var dim = /,\s*(\d{2,5})x(\d{2,5})/.exec(v[0]);
      if(dim){ i.width=+dim[1]; i.height=+dim[2]; }
      var f = /([\d.]+)\s*fps/.exec(v[0]);
      if(f) i.fps = parseFloat(f[1]);
    }
    if(/rotate\s*:\s*(90|270)/.test(log) || /displaymatrix:\s*rotation of -?(90|270)/i.test(log)){
      i.rotated = true;
      var t=i.width; i.width=i.height; i.height=t;
    }
    var a = /Stream #\d+:\d+[^\n]*?:\s*Audio:\s*([A-Za-z0-9_]+)[^\n]*/.exec(log);
    if(a){
      i.hasAudio = true;
      i.audioCodec = a[1].toLowerCase();
      var ab = /,\s*(\d+)\s*kb\/s/.exec(a[0]);
      if(ab) i.audioKbps = +ab[1];
    }
    return i;
  }

  function parseEncoders(log){
    var f={}, re=/^\s*[VASFXBD.]{6}\s+([A-Za-z0-9_-]+)/gm, m;
    while((m=re.exec(log))!==null) f[m[1]]=true;
    return f;
  }

  // ---------------- Scaffold ----------------
  function Scaffold(opts){
    opts = opts || {};
    this.coreType  = opts.coreType || 'auto';           // 'auto'|'mt'|'st'
    this.corePath  = opts.corePath || null;
    // @ffmpeg/ffmpeg spawns a worker from its OWN chunk (e.g. 814.ffmpeg.js),
    // resolved next to wherever ffmpeg.js was served from. If that is a CDN,
    // the worker construction is cross-origin and the browser refuses it.
    // Point this at that chunk and it gets blob-ified like everything else.
    this.classWorkerURL = opts.classWorkerURL || null;
    this.ffmpeg    = null;
    this.ready     = false;
    this.usingMT   = false;
    this._caps     = null;
    this._buf      = [];
    this._cap      = false;
    this._prog     = null;
    this._userLog  = null;
    this._progHook = null;
  }

  Scaffold.prototype._emit = function(stage,pct,msg){
    if(typeof this._prog === 'function')
      this._prog({ stage:stage, percent:clamp(pct,0,100), message:msg||'' });
  };

  Scaffold.prototype.load = function(){
    var self=this;
    if(this.ready) return Promise.resolve(this);
    var C = ffCtor();
    if(!C) return Promise.reject(new Error(
      'ffmpeg.wasm was not found on the page. Add these before scaffold.js:\n' +
      '  <script src="https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js"><\/script>\n' +
      '  <script src="https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js"><\/script>'));

    var useMT = this.coreType==='mt' || (this.coreType==='auto' && mtSupported());
    // corePath accepts a string, or { st:'…', mt:'…' } so the automatic
    // fallback below can retry against the single-threaded build.
    var cp = this.corePath, base;
    if(cp && typeof cp === 'object') base = (useMT ? cp.mt : cp.st) || cp.st || cp.mt;
    else base = cp || (useMT ? CORE_MT : CORE_ST);
    this.usingMT = useMT;
    this.ffmpeg = new C();

    this.ffmpeg.on('log', function(e){
      var line = (e && e.message!=null) ? e.message : String(e);
      if(self._cap) self._buf.push(line);
      if(typeof self._userLog==='function') self._userLog(line);
    });
    this.ffmpeg.on('progress', function(e){
      if(e && typeof e.progress==='number' && self._progHook)
        self._progHook(clamp(e.progress*100,0,100));
    });

    var label = useMT ? 'engine (multithreaded)' : 'engine';
    this._emit('load',0,'Downloading '+label);

    // Track all core files together so the bar reflects the real total.
    var files = [
      { url: base+'/ffmpeg-core.js',   mime:'text/javascript', key:'coreURL' },
      { url: base+'/ffmpeg-core.wasm', mime:'application/wasm', key:'wasmURL' }
    ];
    if(useMT) files.push({ url: base+'/ffmpeg-core.worker.js', mime:'text/javascript', key:'workerURL' });
    if(this.classWorkerURL)
      files.push({ url:this.classWorkerURL, mime:'text/javascript', key:'classWorkerURL' });

    var seen = {}, totals = {};
    function note(i){
      return function(got,total){
        seen[i]=got; totals[i]=total||0;
        var g=0,t=0,k;
        for(k in seen) g+=seen[k];
        for(k in totals) t+=totals[k];
        var mb=(g/1048576).toFixed(1);
        self._emit('load', t ? clamp(g/t*90,0,90) : 0,
          'Downloading '+label+' — '+mb+' MB'+(t?' of '+(t/1048576).toFixed(1)+' MB':''));
      };
    }

    return Promise.all(files.map(function(f,i){
      // Local files go straight through, but MUST be absolute -- see absURL.
      if(sameOrigin(f.url)) return Promise.resolve(absURL(f.url));
      return fetchToBlobURL(f.url, f.mime, note(i));
    })).then(function(urls){
      var cfg = {};
      files.forEach(function(f,i){ cfg[f.key] = urls[i]; });
      self._emit('load',92,'Starting '+label);
      return self.ffmpeg.load(cfg);
    }).then(function(){
      self.ready = true;
      self._emit('load',100,'Engine ready');
      return self;
    }).catch(function(err){
      // Fall back to single-thread if the mt core could not start. The mt
      // build is the fragile one: an extra worker layer plus a hard
      // SharedArrayBuffer requirement. The st build has neither.
      var canFallBack = useMT && self.coreType !== 'st' &&
        (!self.corePath || typeof self.corePath !== 'object' || self.corePath.st);
      if(canFallBack){
        self._emit('load',0,'Multithreaded core failed — retrying single-threaded');
        self.coreType='st'; self.ffmpeg=null; self.usingMT=false; self.ready=false;
        return self.load();
      }
      var detail = (err && (err.message || err.reason)) ||
                   (err && err.type ? 'worker '+err.type+' event' : String(err));
      throw new Error('Could not load the ffmpeg engine from '+base+'. '+
        'Open DevTools > Network and look for ffmpeg-core.js: a blocked or pending '+
        'request there means the CDN is unreachable, a CSP or extension is blocking '+
        'it, or COEP is rejecting the response. Setting corePath to a local folder '+
        'avoids the network entirely. ('+detail+')');
    });
  };

  // Run ffmpeg, capturing its output. Optional timeout rejects a stuck call.
  Scaffold.prototype._exec = function(args, timeoutMs){
    var self=this;
    this._buf=[]; this._cap=true;
    var run = this.ffmpeg.exec(args).then(function(code){
      self._cap=false;
      return { code:code, log:self._buf.join('\n') };
    }, function(err){
      // A non-zero exit is normal for probe calls; surface the log either way.
      self._cap=false;
      return { code:-1, log:self._buf.join('\n'), error:err };
    });
    if(!timeoutMs) return run;
    return Promise.race([run, new Promise(function(_,rej){
      setTimeout(function(){
        rej(new Error('ffmpeg did not respond within '+Math.round(timeoutMs/1000)+
          's and was stopped. Try a shorter clip, or reload the page.'));
      }, timeoutMs);
    })]);
  };

  // Mount the File without copying it into the wasm heap. Falls back to
  // writeFile when WORKERFS is unavailable.
  Scaffold.prototype._attach = function(file, skipBytes){
    var self=this;
    // Blob.slice is lazy — this strips the Tiny6 header without reading the
    // file into memory, which is what keeps 250-350 MB inputs viable.
    if(skipBytes){
      var sliced = file.slice(skipBytes);
      sliced.name = file.name;
      file = sliced;
    }
    var safe = 'src.'+((file.name && extOf(file.name)) || 'webm');
    if(skipBytes) safe = 'src.webm';
    if(typeof this.ffmpeg.mount === 'function' && typeof File !== 'undefined'){
      var FSType = (global.FFmpegWASM && global.FFmpegWASM.FFFSType) ||
                   (global.FFmpeg && global.FFmpeg.FFFSType) || { WORKERFS:'WORKERFS' };
      var renamed;
      try { renamed = new File([file], safe, { type:file.type||'video/mp4' }); }
      catch(e){ return this._copyIn(file, safe); }
      return this.ffmpeg.createDir('/mnt').catch(function(){})
        .then(function(){ return self.ffmpeg.mount(FSType.WORKERFS, { files:[renamed] }, '/mnt'); })
        .then(function(){ return { path:'/mnt/'+safe, mounted:true }; })
        .catch(function(){ return self._copyIn(file, safe); });
    }
    return this._copyIn(file, safe);
  };

  Scaffold.prototype._copyIn = function(file, safe){
    var self=this;
    return file.arrayBuffer().then(function(b){
      return self.ffmpeg.writeFile(safe, new Uint8Array(b));
    }).then(function(){ return { path:safe, mounted:false }; });
  };

  Scaffold.prototype._detach = function(src){
    var self=this;
    if(!src) return Promise.resolve();
    if(src.mounted && typeof this.ffmpeg.unmount==='function'){
      return this.ffmpeg.unmount('/mnt').catch(function(){});
    }
    return this.ffmpeg.deleteFile(src.path).catch(function(){});
  };

  Scaffold.prototype.capabilities = function(){
    var self=this;
    if(this._caps) return Promise.resolve(this._caps);
    return this.load().then(function(){
      return self._exec(['-hide_banner','-encoders']);
    }).then(function(r){
      var e = parseEncoders(r.log);
      self._caps = {
        h264: !!e.libx264,
        vp9:  !!e['libvpx-vp9'] || !!e.libvpx_vp9,
        vp8:  !!e.libvpx,
        hevc: !!e.libx265,
        av1:  !!e.libsvtav1 || !!e['libaom-av1'],
        aac:  !!e.aac,
        opus: !!e.libopus || !!e.opus,
        multithread: self.usingMT,
        all: e
      };
      return self._caps;
    });
  };

  /** Inspect without encoding. */
  Scaffold.prototype.probe = function(file){
    var self=this, src=null;
    if(!file || typeof file.arrayBuffer !== 'function')
      return Promise.reject(new Error('probe() expects a File or Blob.'));

    var t6 = null;
    return this.load().then(function(){
      self._emit('probe',10,'Checking container');
      return file.slice(0,128).arrayBuffer();
    }).then(function(head){
      var u8 = new Uint8Array(head);
      if(Tiny6.isTiny6(u8)) t6 = Tiny6.parseHeader(u8);
      self._emit('probe',20,'Reading stream details');
      return self._attach(file, t6 ? t6.headerSize : 0);
    }).then(function(s){
      src = s;
      // Decode a fraction of a second to a null sink. This exits cleanly,
      // unlike `-i` with no output, which can leave the worker stuck.
      return self._exec(['-hide_banner','-i',src.path,'-t','0.1','-f','null','-'], 120000);
    }).then(function(r){
      var log = r.log;
      return self._detach(src).then(function(){ return log; });
    }).then(function(log){
      var i = parseProbe(log);
      if(!i.videoCodec)
        throw new Error('No video stream found in "'+file.name+'". Supported: mp4, webm, mkv, mov, avi, flv, 3gp.');
      if(!i.durationSec)
        throw new Error('Could not read the duration of "'+file.name+
          '". The file may be truncated or its index damaged.');
      var p = SOURCE_PROFILES[i.videoCodec] || {t:'unknown',r:0.25,l:i.videoCodec};
      i.sourceLabel=p.l; i.tier=p.t; i.realisticReduction=p.r;
      i.originalBytes=file.size;
      i.tiny6 = t6;                       // null unless the input was .ts6/.tn6
      i.headerBytes = t6 ? t6.headerSize : 0;
      i.videoKbps = Math.max(0,(i.totalKbps||0)-(i.audioKbps||0));
      self._emit('probe',100,'Analysed');
      return i;
    }).catch(function(err){
      return self._detach(src).then(function(){ throw err; });
    });
  };

  /** Largest ladder rung the given video bitrate can actually support. */
  Scaffold.prototype.pickHeight = function(info, videoKbps){
    var fps = info.fps || 30;
    var aspect = (info.width && info.height) ? info.width/info.height : 16/9;
    for(var i=0;i<LADDER.length;i++){
      var h = LADDER[i].h;
      if(h > info.height) continue;                    // never upscale
      var w = Math.round(h*aspect/2)*2;
      var need = w*h*fps*0.022/1000;                   // ~0.022 bpp: the point below
                                                       // which this rung stops holding up
      if(videoKbps >= need) return h;
    }
    return Math.min(info.height, 240);
  };

  Scaffold.prototype._vfArgs = function(info,outH,o){
    var chain = [];
    // Luma runs first, on source pixels. After a pad it would tint the bars.
    var lf = lumaFilter(o.luma, o.lumaMode);
    if(lf) chain.push(lf);
    if(o.tiny6) chain.push(Tiny6.filterChain());
    else if(outH && outH < info.height) chain.push('scale=-2:'+outH+':flags=bicubic');
    return chain.length ? ['-vf', chain.join(',')] : [];
  };

  Scaffold.prototype._videoArgs = function(vcodec,crf,preset){
    if(vcodec==='libvpx')
      return ['-c:v','libvpx','-crf',String(crf),'-b:v','0','-quality','good','-cpu-used','2'];
    if(vcodec==='libvpx-vp9')
      return ['-c:v','libvpx-vp9','-crf',String(crf),'-b:v','0',
              '-deadline','good','-cpu-used','4','-row-mt','1'];
    return ['-c:v','libx264','-preset',preset,'-crf',String(crf),
            '-pix_fmt','yuv420p','-profile:v','high'];
  };

  Scaffold.prototype._audioArgs = function(info,audioKbps,audioChannels,container,caps){
    if(!info.hasAudio || audioKbps==='none') return { args:['-an'], kbps:0, channels:0 };
    var codec = container==='webm' ? (caps.opus?'libopus':'libvorbis') : 'aac';
    var kbps = clamp(+audioKbps, 16, 320);
    var ch = audioChannels==='auto' ? (kbps<=48?1:2) : +audioChannels;
    return { args:['-c:a',codec,'-b:a',kbps+'k','-ac',String(ch)], kbps:kbps, channels:ch };
  };

  /** Compress. Returns { blob, filename, stats }. */
  Scaffold.prototype.shrink = function(file, opts){
    var self=this, o={};
    for(var k in DEFAULTS) o[k]=DEFAULTS[k];
    for(var k2 in (opts||{})) if(opts[k2]!==undefined) o[k2]=opts[k2];

    this._prog = o.onProgress;
    this._userLog = o.onLog;

    o.luma = clamp(+o.luma || 1, 0.70, 1.0);
    if(o.lumaMode!=='raw') o.lumaMode='safe';

    var t0=Date.now(), caps=null, info=null, src=null, warnings=[], attempts=[];

    if(o.luma < 1){
      warnings.push('Luma scaled to '+o.luma.toFixed(2)+' ('+o.lumaMode+'). This permanently '+
        'darkens the picture; no player will correct for it. Raising CRF instead often '+
        'reaches the same size with less visible change -- compare both before committing.');
      if(o.lumaMode==='raw'){
        warnings.push('Raw mode drives limited-range black from 16 down to '+
          Math.round(16*o.luma)+', below the legal floor, so shadow detail is clipped away. '+
          'Safe mode holds black at 16.');
      }
      if(o.luma <= 0.82){
        warnings.push('At luma '+o.luma.toFixed(2)+' white falls from 235 to '+
          Math.round((235-16)*o.luma+16)+', which reads as grey rather than white.');
      }
    }
    var vcodec, container, mime, outH, audio, chosenCrf;

    if(file.size > MAX_SAFE_BYTES){
      warnings.push('Input is '+fmtBytes(file.size)+', above the '+fmtBytes(MAX_SAFE_BYTES)+
        ' guideline. It may exhaust browser memory.');
    }

    return this.capabilities().then(function(c){
      caps=c;
      if(!caps.h264 && !caps.vp9)
        throw new Error('This ffmpeg core has neither libx264 nor libvpx-vp9, so it cannot encode video.');
      return self.probe(file);
    }).then(function(i){
      info=i;

      if(o.tiny6){
        // Tiny6 is a WebM payload, so the codec choice is VP9 or VP8 only.
        if(o.codec==='vp8' && caps.vp8) vcodec='libvpx';
        else if(caps.vp9) vcodec='libvpx-vp9';
        else if(caps.vp8) vcodec='libvpx';
        else throw new Error('Tiny6 output needs libvpx (VP8/VP9), which this ffmpeg core does not have.');
      }
      else if(o.codec==='vp9' && caps.vp9) vcodec='libvpx-vp9';
      else if(o.codec==='h264' && caps.h264) vcodec='libx264';
      else vcodec = caps.h264 ? 'libx264' : 'libvpx-vp9';
      container = (o.tiny6 || vcodec==='libvpx-vp9' || vcodec==='libvpx') ? 'webm' : 'mp4';
      mime = container==='webm' ? 'video/webm' : 'video/mp4';

      if(o.tiny6 && info.width && info.height){
        var srcPx = info.width*info.height, outPx = Tiny6.CODED_W*Tiny6.CODED_H;
        if(info.height <= Tiny6.DISPLAY_H && srcPx <= outPx*1.15){
          warnings.push('Source is '+info.width+'x'+info.height+
            ', at or below the '+Tiny6.DISPLAY_W+'x'+Tiny6.DISPLAY_H+
            ' Tiny6 frame. Re-encoding will upscale and is likely to produce a LARGER file. '+
            'Tiny6 pays off on large sources coming down, not on its own output.');
        }
      }

      if(info.tier==='modern'){
        warnings.push(info.sourceLabel+' is already an efficient modern codec. Re-encoding to '+
          (vcodec==='libx264'?'H.264':'VP9')+' may produce a larger file at the same quality.');
      }

      var targetBytes = o.mode==='target' ? o.targetMB*1024*1024 : 0;
      var totalKbps = targetBytes ? (targetBytes*8*0.985)/info.durationSec/1000 : 0;

      // Audio budget first — at small targets it can eat everything.
      var aKbps = o.audioKbps;
      if(aKbps==='auto'){
        aKbps = (o.mode==='target')
          ? clamp(Math.round(totalKbps*0.18), 24, 128)
          : 96;
      }
      audio = self._audioArgs(info, aKbps, o.audioChannels, container, caps);
      var videoKbps = Math.max(8, totalKbps - audio.kbps);

      if(o.mode==='target' && info.hasAudio && audio.kbps >= totalKbps*0.5){
        warnings.push('Audio at '+audio.kbps+' kbps takes most of the '+o.targetMB+
          ' MB budget for a '+Math.round(info.durationSec)+'s video. Lower audioKbps or raise the target.');
      }

      if(o.tiny6){
        outH = Tiny6.CODED_H;                 // geometry is fixed by the format
      } else if(o.maxHeight==='auto'){
        outH = (o.mode==='target') ? self.pickHeight(info, videoKbps) : info.height;
      } else {
        outH = (+o.maxHeight)|0;
        if(!outH || outH>=info.height) outH = info.height;
      }
      if(!o.tiny6 && outH < info.height){
        warnings.push('Downscaling '+info.width+'x'+info.height+' to '+outH+
          'p — at this budget the original resolution could not hold up.');
      }

      if(o.mode==='crf'){
        chosenCrf = clamp(o.crf, 0, vcodec==='libvpx-vp9'?63:51);
        return null;
      }
      return self._search(file, info, o, vcodec, container, outH, audio, targetBytes, attempts, warnings);
    }).then(function(sr){
      if(sr) chosenCrf = sr.crf;
      self._emit('encode',0,'Encoding at CRF '+chosenCrf+
        (o.tiny6 ? ' · '+Tiny6.DISPLAY_W+'x'+Tiny6.DISPLAY_H+' anamorphic'
                 : (outH<info.height?' · '+outH+'p':'')));
      return self._attach(file, info.headerBytes||0);
    }).then(function(s){
      src=s;
      if(!s.mounted && file.size > 120*1024*1024){
        warnings.push('WORKERFS mounting was unavailable, so the file was copied into memory. '+
          'Large inputs are more likely to fail this way.');
      }
      var out='out.'+container;
      self._progHook = function(p){ self._emit('encode', p, 'Encoding'); };
      var args=['-hide_banner','-y','-i',src.path]
        .concat(self._vfArgs(info,outH,o))
        .concat(self._videoArgs(vcodec,chosenCrf,o.preset))
        .concat(audio.args)
        .concat(container==='mp4'?['-movflags','+faststart']:[])
        .concat([out]);
      return self._exec(args, o.execTimeoutMs).then(function(r){
        self._progHook=null;
        return self.ffmpeg.readFile(out).then(function(d){
          return { data:d, out:out, log:r.log };
        });
      });
    }).then(function(r){
      var bytes = r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data);
      if(!bytes.length)
        throw new Error('Encoding produced an empty file. The source may use an unsupported '+
          'pixel format, or the settings were out of range. Check the ffmpeg output.');
      var res;
      if(o.tiny6){
        var hdr = Tiny6.buildHeader({
          payloadBytes: bytes.length,
          width: Tiny6.CODED_W, height: Tiny6.CODED_H,
          fpsNum: Math.round((info.fps||23.976)*1001), fpsDen: 1001,
          sampleRate: audio.kbps ? 48000 : 0,
          audioKbps: audio.kbps||0,
          channels: audio.channels||0,
          videoCodec: vcodec==='libvpx' ? 'VP8' : 'VP9',
          audioCodec: audio.kbps ? 'OPUS' : '',
          mime: 'video/webm',
          sourceFormat: (extOf(file.name)||'').toUpperCase(),
          title: Tiny6.makeTitle(file.name)
        });
        res = { blob: new Blob([hdr, bytes], {type:'application/octet-stream'}),
                filename: baseOf(file.name)+'.'+Tiny6.EXT,
                bytes: hdr.length + bytes.length, out:r.out };
      } else {
        res = { blob:new Blob([bytes],{type:mime}),
                filename:baseOf(file.name)+'.small.'+container,
                bytes:bytes.length, out:r.out };
      }
      if(!o.verify) return res;
      // Always measured against the TRUE original, never against the
      // luma-scaled intermediate -- otherwise darkening would score as free.
      self._emit('verify',0,'Comparing against the original');
      var uf = lumaUnfilter(o.luma, o.lumaMode);
      return self._exec(['-hide_banner','-i',res.out,'-i',src.path,'-lavfi','ssim','-f','null','-'])
        .then(function(rr){
          var m=/All:\s*([\d.]+)/.exec(rr.log);
          res.ssim = m?parseFloat(m[1]):null;
        }, function(){ res.ssim=null; })
        .then(function(){
          if(!uf) return res;
          // Undo the luma scaling, then compare again. The gap between this
          // and res.ssim is the part of the loss that is only brightness.
          self._emit('verify',50,'Separating brightness from detail loss');
          return self._exec(['-hide_banner','-i',res.out,'-vf',uf,'-i',src.path,
                             '-lavfi','[0:v][1:v]ssim','-f','null','-'])
            .then(function(rr2){
              var m2=/All:\s*([\d.]+)/.exec(rr2.log);
              res.ssimDetail = m2?parseFloat(m2[1]):null;
              return res;
            }, function(){ res.ssimDetail=null; return res; });
        });
    }).then(function(res){
      return self.ffmpeg.deleteFile(res.out).catch(function(){})
        .then(function(){ return self._detach(src); })
        .then(function(){ return res; });
    }).then(function(res){
      var saved = file.size - res.bytes;
      var stats = {
        originalBytes: file.size,
        outputBytes: res.bytes,
        savedBytes: saved,
        reduction: saved/file.size,                      // vs ORIGINAL, always
        reductionPercent: +(saved/file.size*100).toFixed(2),
        grew: saved<0,
        crf: chosenCrf,
        outputHeight: outH,
        sourceHeight: info.height,
        tiny6: !!o.tiny6,
        displayWidth: o.tiny6 ? Tiny6.DISPLAY_W : null,
        displayHeight: o.tiny6 ? Tiny6.DISPLAY_H : null,
        codedWidth: o.tiny6 ? Tiny6.CODED_W : null,
        targetCodec: vcodec==='libx264'?'H.264':'VP9',
        sourceCodec: info.sourceLabel,
        audioKbps: audio.kbps,
        audioChannels: audio.channels,
        durationSec: info.durationSec,
        attempts: attempts,
        luma: o.luma<1 ? o.luma : null,
        lumaMode: o.luma<1 ? o.lumaMode : null,
        ssim: res.ssim===undefined?null:res.ssim,
        ssimDetail: res.ssimDetail===undefined?null:res.ssimDetail,
        multithread: self.usingMT,
        elapsedMs: Date.now()-t0,
        warnings: warnings,
        summary: fmtBytes(file.size)+' -> '+fmtBytes(res.bytes)+' ('+
                 (saved>=0?'-':'+')+Math.abs(saved/file.size*100).toFixed(1)+'%)'
      };
      if(stats.luma && stats.grew){
        warnings.push('Luma scaling did not pay for itself here -- the output grew. '+
          'Flat or already-dark sources often band under Y scaling, and contours cost '+
          'more bits than the scaling saves. Try luma 1.0 with a higher CRF.');
      }
      if(stats.luma && stats.ssim!==null && stats.ssimDetail!==null){
        stats.brightnessOnlyLoss = +(stats.ssimDetail - stats.ssim).toFixed(4);
      }
      self._emit('done',100,stats.summary);
      return { blob:res.blob, filename:res.filename, stats:stats };
    }).catch(function(err){
      self._progHook=null;
      return self._detach(src).then(function(){ throw err; });
    });
  };

  /**
   * Find the CRF that lands near the target by encoding short samples and
   * projecting to full duration. Every +6 CRF is roughly half the size.
   */
  Scaffold.prototype._search = function(file, info, o, vcodec, container, outH, audio, targetBytes, attempts, warnings){
    var self=this;
    var maxCrf = vcodec==='libvpx-vp9'?63:51, minCrf=16;
    var sampleDur = Math.max(2, Math.min(o.sampleSeconds, info.durationSec*0.25));
    var seek = Math.max(0, info.durationSec*0.40);
    var audioBytes = audio.kbps*1000/8*info.durationSec;
    var videoBudget = Math.max(1024, targetBytes - audioBytes);
    var crf = 30, src=null, best=null;

    return this._attach(file, info.headerBytes||0).then(function(s){
      src=s;
      var i=0;
      function step(){
        if(i >= o.maxIterations) return Promise.resolve();
        var thisCrf = clamp(Math.round(crf), minCrf, maxCrf);
        self._emit('search', (i/o.maxIterations)*100,
          'Testing CRF '+thisCrf+' on a '+Math.round(sampleDur)+'s sample ('+(i+1)+'/'+o.maxIterations+')');

        var out='s'+i+'.'+container;
        var args=['-hide_banner','-y','-ss',seek.toFixed(2),'-t',sampleDur.toFixed(2),'-i',src.path]
          .concat(self._vfArgs(info,outH,o))
          .concat(self._videoArgs(vcodec,thisCrf,o.preset))
          .concat(['-an', out]);

        return self._exec(args, o.execTimeoutMs).then(function(){
          return self.ffmpeg.readFile(out);
        }).then(function(d){
          var n = (d instanceof Uint8Array ? d : new Uint8Array(d)).length;
          return self.ffmpeg.deleteFile(out).catch(function(){}).then(function(){ return n; });
        }).then(function(sampleBytes){
          if(!sampleBytes){
            // Sample failed; keep the current CRF rather than dividing by zero.
            i = o.maxIterations;
            if(!best) best = { crf:thisCrf, err:0 };
            return;
          }
          // Project the sample rate across the FULL duration.
          var projVideo = sampleBytes / sampleDur * info.durationSec;
          var projTotal = projVideo + audioBytes;
          var err = projTotal/targetBytes - 1;
          attempts.push({ crf:thisCrf, sampleBytes:sampleBytes,
                          projectedBytes:Math.round(projTotal),
                          errorPercent:+(err*100).toFixed(1) });

          if(!best || Math.abs(err) < Math.abs(best.err)) best={ crf:thisCrf, err:err };
          if(Math.abs(err) <= o.tolerance){ i = o.maxIterations; return; }

          var delta = 6 * (Math.log(projVideo/Math.max(1,videoBudget))/Math.LN2);
          var next = clamp(thisCrf + clamp(delta,-12,12), minCrf, maxCrf);
          if(Math.round(next) === thisCrf){ i = o.maxIterations; return; }
          crf = next; i++;
          return step();
        });
      }
      return step();
    }).then(function(){
      return self._detach(src);
    }).then(function(){
      var chosen = best ? best.crf : 30;
      if(best && best.err > o.tolerance){
        warnings.push('Could not reach '+o.targetMB+' MB even at CRF '+chosen+
          '. Projected about '+fmtBytes(Math.round(targetBytes*(1+best.err)))+
          '. Downscale further or allow a larger target.');
      }
      if(chosen >= 44){
        warnings.push('CRF '+chosen+' is very aggressive — expect visible blocking and smearing.');
      }
      return { crf:chosen };
    }).catch(function(err){
      return self._detach(src).then(function(){ throw err; });
    });
  };

  Scaffold.prototype.terminate = function(){
    try{ if(this.ffmpeg && this.ffmpeg.terminate) this.ffmpeg.terminate(); }catch(e){}
    this.ready=false; this.ffmpeg=null; this._caps=null;
  };

  Scaffold.shrink = function(file,opts){ return new Scaffold(opts||{}).shrink(file,opts); };
  Scaffold.probe  = function(file,opts){ return new Scaffold(opts||{}).probe(file); };

  Scaffold.Tiny6 = Tiny6;
  Scaffold.fmtBytes = fmtBytes;
  Scaffold.SOURCE_PROFILES = SOURCE_PROFILES;
  Scaffold.LADDER = LADDER;
  /**
   * Settings measured on real content rather than guessed. TN6 numbers come
   * from a 640x360 VP9 source that landed at SSIM 0.975 / PSNR 36.7 dB for a
   * 27% saving. Luma defaults to off: at matched output size, raising CRF beat
   * luma scaling on every clip tested. Turn it on only if a bench says so.
   */
  Scaffold.PRESETS = {
    tn6:      { tiny6:true,  mode:'crf', crf:34, codec:'vp9',  luma:1.0, verify:false },
    balanced: { tiny6:false, mode:'crf', crf:32, codec:'auto', luma:1.0 },
    small:    { tiny6:false, mode:'crf', crf:37, codec:'auto', luma:1.0 }
  };

  /** Shorthand: Scaffold.preset('tn6', { verify:true }) */
  Scaffold.preset = function(name, over){
    var base = Scaffold.PRESETS[name];
    if(!base) throw new Error('Unknown preset "'+name+'". Try: '+
      Object.keys(Scaffold.PRESETS).join(', '));
    var o = {};
    for(var k in base) o[k]=base[k];
    for(var k2 in (over||{})) o[k2]=over[k2];
    return o;
  };

  Scaffold.version = '3.4.0';

  global.Scaffold = Scaffold;
  if(typeof module!=='undefined' && module.exports) module.exports = Scaffold;

})(typeof window!=='undefined' ? window : this);
