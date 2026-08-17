/*!
 * tiny6-player.js — v1.0.0
 * Plays .tn6 / .ts6 files in any <video> element. No dependencies.
 *
 *   <script src="tiny6-player.js"></script>
 *
 * A .tn6 file is a 128-byte little-endian header followed by a WebM
 * payload. Playback is therefore just: read the header, slice it off,
 * hand the rest to the browser as a Blob. The anamorphic display size
 * is carried in the WebM's own sample aspect ratio, so browsers stretch
 * 512x384 out to 683x384 without being told to.
 *
 * Markup-driven use:
 *   <video data-tn6="clip.tn6" controls></video>
 *
 * Script use:
 *   Tiny6Player.attach(videoEl, fileOrUrlOrBuffer).then(function(meta){ ... });
 */
(function (global) {
  'use strict';

  var MAGIC = 'TS6V';
  var HEADER_MIN = 128;

  function ascii(view, off, len) {
    var out = '', i, c;
    for (i = 0; i < len; i++) {
      c = view.getUint8(off + i);
      if (c === 0) break;
      out += String.fromCharCode(c);
    }
    return out;
  }

  function isTiny6(u8) {
    return u8 && u8.length >= 8 &&
           u8[0] === 0x54 && u8[1] === 0x53 && u8[2] === 0x36 && u8[3] === 0x56;
  }

  /** Read the 128-byte header. Throws if the bytes are not a Tiny6 file. */
  function parse(u8) {
    if (!isTiny6(u8)) {
      throw new Error('Not a Tiny6 file — expected the magic bytes ' + MAGIC +
                      ' at offset 0. Check the file is .tn6 and not a plain .webm.');
    }
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var headerSize = dv.getUint16(6, true) || HEADER_MIN;
    var m = {
      magic:        MAGIC,
      versionMajor: dv.getUint8(4),
      versionMinor: dv.getUint8(5),
      headerSize:   headerSize,
      payloadBytes: dv.getUint32(8, true),
      codedWidth:   dv.getUint16(12, true),
      codedHeight:  dv.getUint16(14, true),
      maxWidth:     dv.getUint16(16, true),
      maxHeight:    dv.getUint16(18, true),
      fpsNum:       dv.getUint32(20, true),
      fpsDen:       dv.getUint32(24, true),
      sampleRate:   dv.getUint32(28, true),
      channels:     dv.getUint8(32),
      audioKbps:    dv.getUint32(33, true),
      videoCodec:   ascii(dv, 40, 8),
      audioCodec:   ascii(dv, 48, 8),
      mime:         ascii(dv, 56, 16) || 'video/webm',
      sourceFormat: ascii(dv, 80, 8),
      title:        ascii(dv, 88, 32),
      payloadOffset: dv.getUint32(120, true) || headerSize
    };
    m.fps = m.fpsDen ? m.fpsNum / m.fpsDen : 0;
    // Display size comes from the 4:3 sample aspect, NOT from maxWidth/maxHeight
    // — those are a ceiling the encoder honoured, not the geometry. 512 coded
    // pixels display as 683, which is why 683 may be odd: it is never a coded
    // width, only a displayed one.
    m.displayWidth  = Math.round(m.codedWidth * 4 / 3);
    m.displayHeight = m.codedHeight;
    m.actualPayloadBytes = u8.length - m.payloadOffset;
    if (m.payloadBytes && m.actualPayloadBytes !== m.payloadBytes) {
      m.warning = 'Header claims ' + m.payloadBytes + ' payload bytes but the file ' +
                  'holds ' + m.actualPayloadBytes + '. It may be truncated.';
    }
    return m;
  }

  /** Strip the header and return a playable Blob. */
  function toBlob(u8) {
    var m = parse(u8);
    return { blob: new Blob([u8.subarray(m.payloadOffset)], { type: m.mime }), meta: m };
  }

  function readFile(file) {
    return new Promise(function (res, rej) {
      if (file.arrayBuffer) { file.arrayBuffer().then(res, rej); return; }
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(new Error('Could not read ' + (file.name || 'the file') + '.')); };
      fr.readAsArrayBuffer(file);
    });
  }

  function fetchUrl(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Could not fetch ' + url + ' (HTTP ' + r.status + ').');
      return r.arrayBuffer();
    });
  }

  function toBytes(source) {
    if (typeof source === 'string') return fetchUrl(source);
    if (source instanceof ArrayBuffer) return Promise.resolve(source);
    if (source instanceof Uint8Array) return Promise.resolve(source.buffer);
    if (global.Blob && source instanceof Blob) return readFile(source);
    return Promise.reject(new Error('attach() takes a URL, File, Blob, ArrayBuffer or Uint8Array.'));
  }

  var urls = [];   // object URLs to revoke on unload

  /**
   * Point a <video> at a Tiny6 source.
   * Returns a Promise resolving to the parsed header metadata.
   */
  function attach(video, source) {
    if (!video || video.tagName !== 'VIDEO') {
      return Promise.reject(new Error('attach() needs a <video> element as its first argument.'));
    }
    return toBytes(source).then(function (buf) {
      var r = toBlob(new Uint8Array(buf));
      if (video.dataset.tn6ObjectUrl) URL.revokeObjectURL(video.dataset.tn6ObjectUrl);
      var url = URL.createObjectURL(r.blob);
      urls.push(url);
      video.dataset.tn6ObjectUrl = url;
      video.src = url;
      if (r.meta.title && !video.getAttribute('title')) video.setAttribute('title', r.meta.title);
      video.dispatchEvent(new CustomEvent('tiny6load', { detail: r.meta, bubbles: true }));
      return r.meta;
    });
  }

  /** Free the object URL behind a video that attach() populated. */
  function release(video) {
    var u = video && video.dataset && video.dataset.tn6ObjectUrl;
    if (u) { URL.revokeObjectURL(u); delete video.dataset.tn6ObjectUrl; video.removeAttribute('src'); }
  }

  /** Upgrade every <video data-tn6="..."> on the page. */
  function autoInit(root) {
    var nodes = (root || document).querySelectorAll('video[data-tn6]');
    Array.prototype.forEach.call(nodes, function (v) {
      if (v.dataset.tn6Ready) return;
      v.dataset.tn6Ready = '1';
      attach(v, v.dataset.tn6)['catch'](function (err) {
        v.dispatchEvent(new CustomEvent('tiny6error', { detail: err, bubbles: true }));
        if (global.console) console.error('[tiny6]', err.message);
      });
    });
  }

  global.addEventListener('unload', function () {
    urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { autoInit(); });
  } else {
    autoInit();
  }

  global.Tiny6Player = {
    version: '1.0.0',
    isTiny6: isTiny6,
    parse: parse,
    toBlob: toBlob,
    attach: attach,
    release: release,
    autoInit: autoInit
  };

}(typeof window !== 'undefined' ? window : this));
