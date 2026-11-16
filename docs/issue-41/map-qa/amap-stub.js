// QA-only window.AMap surface — served to the page in place of the real
// webapi.amap.com script via CDP Fetch.fulfill. It implements just enough of
// JS API 2.0 for frontend/amap.js to run end-to-end: marker content is real
// DOM inside a #map overlay, geo anchoring uses a linear projection, and
// convertFrom applies the usual WGS→GCJ offset. NOT the real AMap SDK — the
// report labels every result "SDK stub" accordingly.
(function () {
  const listeners = new WeakMap();
  const on = (t, n, cb) => { let m = listeners.get(t); if (!m) { m = new Map(); listeners.set(t, m); } m.set(n, cb); };
  const emit = (t, n, ...a) => { try { listeners.get(t)?.get(n)?.(...a); } catch (e) { console.error(e); } };

  class Pixel { constructor(x, y) { this.x = x; this.y = y; } }
  class LngLat { constructor(lng, lat) { this.lng = lng; this.lat = lat; } }

  class Marker {
    constructor(o = {}) {
      this.o = o; this._map = null; this._offset = { x: 0, y: 0 };
      this._pos = Array.isArray(o.position) ? [...o.position] : (o.position ? [o.position.lng, o.position.lat] : [0, 0]);
      const el = typeof o.content === 'string' ? document.createElement('div') : (o.content || document.createElement('div'));
      if (typeof o.content === 'string') el.innerHTML = o.content;
      this.el = el;
      el.style.position = 'absolute';
      el.style.pointerEvents = 'auto';
      if (o.anchor === 'center') el.style.transform = 'translate(-50%,-50%)';
      else if (o.anchor === 'top-left') el.style.transform = 'translate(0,-100%)';
      if (o.title) el.title = o.title;
      if (o.zIndex != null) el.style.zIndex = o.zIndex;
      el.addEventListener('click', () => emit(this, 'click'));
    }
    setMap(m) { if (this._map === m) return; if (this._map) this._map.__remove(this); this._map = m; if (m) m.__add(this); }
    setPosition(p) { this._pos = Array.isArray(p) ? [...p] : [p.lng, p.lat]; this._map?.__layout(this); }
    getPosition() { return [...this._pos]; }
    setOffset(px) { this._offset = { x: px?.x ?? 0, y: px?.y ?? 0 }; this._map?.__layout(this); }
    setTitle(t) { this.o.title = t; this.el.title = t; }
    setOptions(o) { Object.assign(this.o, o); }
    on(n, cb) { on(this, n, cb); }
  }

  class Polyline extends Marker {
    constructor(o = {}) { super({ position: o.path?.[0] || [0, 0] }); this.o = o; this._path = o.path || []; this.el.style.display = 'none'; }
    setPath(p) { this._path = p; this._pos = p?.[0] ? [...p[0]] : this._pos; }
    getPath() { return this._path; }
  }

  class AMapMap {
    constructor(id, o = {}) {
      this.o = o; this.el = typeof id === 'string' ? document.getElementById(id) : id;
      this.center = Array.isArray(o.center) ? [...o.center] : [108.95, 34.27];
      this.zoom = o.zoom || 11;
      this._layers = new Set();
      this.overlay = document.createElement('div');
      this.overlay.setAttribute('data-amap-stub', 'overlay');
      this.overlay.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:5;';
      const cs = getComputedStyle(this.el);
      if (cs.position === 'static') this.el.style.position = 'relative';
      this.el.append(this.overlay);
      this.overlay.style.pointerEvents = 'none';
      setTimeout(() => emit(this, 'complete'), 0);
    }
    __add(m) { this._layers.add(m); if (m.el) this.overlay.append(m.el); this.__layout(m); }
    __remove(m) { this._layers.delete(m); m.el?.remove?.(); }
    __layout(m) {
      if (!m.el || !m._pos) return;
      const p = this.lngLatToContainer(m._pos), off = m._offset || { x: 0, y: 0 };
      m.el.style.left = (p.x + off.x) + 'px'; m.el.style.top = (p.y + off.y) + 'px';
    }
    __relayout() { for (const m of this._layers) this.__layout(m); }
    _scale() { return 8000 * Math.pow(2, (this.zoom - 11) / 2); }
    lngLatToContainer(p) {
      const lng = p?.lng ?? p?.[0] ?? 0, lat = p?.lat ?? p?.[1] ?? 0, s = this.getSize();
      return { x: s.width / 2 + (lng - this.center[0]) * this._scale(), y: s.height / 2 - (lat - this.center[1]) * this._scale() };
    }
    getSize() { const r = this.el.getBoundingClientRect(); return { width: r.width || 800, height: r.height || 600, getWidth: () => r.width || 800, getHeight: () => r.height || 600 }; }
    getZoom() { return this.zoom; }
    setZoom(z) { this.zoom = z; emit(this, 'zoomchange'); emit(this, 'zoomend'); emit(this, 'moveend'); this.__relayout(); }
    setZoomAndCenter(z, c) { if (c) this.center = Array.isArray(c) ? [...c] : [c.lng, c.lat]; if (z) this.zoom = z; this.__relayout(); emit(this, 'zoomend'); emit(this, 'moveend'); }
    setCenter(c) { this.center = Array.isArray(c) ? [...c] : [c.lng, c.lat]; this.__relayout(); }
    setFitView() { /* camera fit is recorded by callers; QA stub keeps the frame */ }
    getBounds() {
      const s = this.getSize(), half = { w: s.width / this._scale() / 2, h: s.height / this._scale() / 2 }, c = this.center;
      return { getSouthWest: () => ({ getLng: () => c[0] - half.w, getLat: () => c[1] - half.h }), getNorthEast: () => ({ getLng: () => c[0] + half.w, getLat: () => c[1] + half.h }) };
    }
    on(n, cb) { on(this, n, cb); }
    add(items) { for (const m of Array.isArray(items) ? items : [items]) { if (m?.setMap) m.setMap(this); else this._layers.add(m); } }
    remove(items) { for (const m of Array.isArray(items) ? items : [items]) { if (m?.setMap) m.setMap(null); else this._layers.delete(m); } }
    addControl() { }
    setFeatures() { } set() { } resize() { emit(this, 'resize'); }
    isDOMMode() { return false; }
    getContainer() { return this.el; }
    destroy() { this.overlay.remove(); this._layers.clear(); }
  }

  const defer = cb => setTimeout(cb, 0);
  window.AMap = {
    Map: AMapMap, Marker, Polyline, Pixel, LngLat,
    ToolBar: class { constructor(o) { this.o = o; } },
    plugin(_names, cb) { defer(cb); },
    convertFrom(batch, _type, cb) {
      const locations = batch.map(p => ({ lng: p[0] + 0.006, lat: p[1] + 0.004 }));
      defer(() => cb('complete', { locations }));
    },
    Geocoder: class {
      getAddress(_pt, cb) { defer(() => cb('complete', { regeocode: { addressComponent: { adcode: '610100', district: '雁塔区' }, formattedAddress: '西安市雁塔区' } })); }
      getLocation(q, cb) { defer(() => cb('complete', { geocodes: [{ location: { lng: 108.95, lat: 34.28 }, formattedAddress: String(q) }] })); }
    },
    PlaceSearch: class { constructor(o) { this.o = o; } search(_q, cb) { defer(() => cb('complete', { poiList: { pois: [] } })); } },
    Weather: class { getLive(_a, cb) { defer(() => cb(null, { temperature: '22', weather: '晴' })); } },
  };
})();
