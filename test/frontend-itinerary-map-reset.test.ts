import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {setup,Element} from './frontend-fixture.ts';
const nodes=(root:Element):Element[]=>[root,...root.children.flatMap(nodes)];
const source=(name:string)=>readFileSync(new URL('../frontend/'+name,import.meta.url),'utf8');
const payload=JSON.parse(readFileSync(new URL('../docs/mocks/day0/response-comparison.json',import.meta.url),'utf8'));

test('reset during focus entry cannot let a pending palette redraw repopulate the old map routes',async()=>{
 const h=setup({api:false}),attached=new Set<unknown>();
 h.$('plan-detail').hidden=true;
 h.context.CustomEvent=class extends Event{detail:unknown;constructor(type:string,options:{detail:unknown}){super(type);this.detail=options.detail;}};
 h.context.document.getElementById=h.$;
 Object.assign(h.$('card'),{getBoundingClientRect:()=>({right:450,height:844})});
 h.context.locationMarker=null;h.context.tiles=null;
 h.context.requestAnimationFrame=()=>1;
 h.context.map={stop(){},removeLayer(layer:unknown){attached.delete(layer)},getSize(){return {x:1440,y:900}},getZoom(){return 15},fitBounds(){},on(){},off(){}};
 const layer=()=>({bindTooltip(){return this},on(){return this},setLatLngs(){},setStyle(){}});
 h.context.L={circleMarker:layer,polyline:layer,latLngBounds:(p:unknown)=>p,layerGroup:()=>({addTo(){attached.add(this);return this},on(){},off(){}})};
 h.context.locationLabel=(s:string)=>s;
 // Preserve production listener order: controller is loaded before plans.
 h.run(source('itinerary-map.js'));h.run(source('plans.js'));h.run(source('transport.js'));h.run(source('chat.js'));
 const pending:((palette:Map<string,{color:string}>)=>void)[]=[];
 h.context.window.WanderRouteVisuals.palette=()=>new Promise(resolve=>pending.push(resolve));
 h.context.payload={...payload,coordinate_system:'WGS84'};h.run('window.WanderPlans.append(payload)');
 const palette=new Map<string,{color:string}>(payload.plans.map((p:any)=>[p.plan_id,{color:'#167744'}]));
 pending.splice(0).forEach(resolve=>resolve(palette));await Promise.resolve();
 assert.equal(attached.size,1,'baseline route has actually rendered');
 const preview=nodes(h.$('messages')).find(n=>n.classes.has('plan-preview'))!;
 assert(preview);preview.click();h.$('new-chat').click();
 // Palette completions queued by entering/leaving arrive after the reset.
 pending.splice(0).forEach(resolve=>resolve(palette));await Promise.resolve();await Promise.resolve();
 assert.equal(h.context.window.WanderItineraryFocus.phase,'explore');assert.equal(h.context.window.WanderItineraryFocus.model,null);
 assert.equal(attached.size,0,'old palette completions must not reattach route groups after reset');
});
