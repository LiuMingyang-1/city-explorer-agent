/** Export existing seed templates without touching a developer's SQLite database. */
import {mkdirSync,writeFileSync} from 'node:fs';
import {generateSeedEvents} from '../src/data/seed.ts';
const date=process.argv.find(a=>a.startsWith('--date='))?.slice(7)||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const source='https://github.com/LiuMingyang-1/city-explorer-agent/blob/main/src/data/seed-templates.ts';
const events=generateSeedEvents(date).map(e=>({
 event_id:e.id,title:e.title,description:e.description,category:e.category,venue_name:e.venueName,address:e.address,
 latitude:e.latitude,longitude:e.longitude,start_at:e.startAt,end_at:e.endAt,suggested_duration_minutes:e.suggestedDurationMinutes,
 budget_min:e.budgetMin,budget_max:e.budgetMax,currency:e.currency,budget_note:e.budgetNote,
 // Seed image/guide URLs point at example.com. Use local illustrative photos and a working data-source link.
 guide_url:null,source_url:source,is_demo:true,image_note:'示意配图 · 非活动实拍',
 thumbnail_url:'/assets/demo/'+(/书|讲座/.test(e.category)?'books':/市集/.test(e.category)?'market':/演出|音乐|放映/.test(e.category)?'performance':'exhibition')+'.jpg',image_urls:[],
}));
mkdirSync('frontend/data',{recursive:true});
writeFileSync('frontend/data/demo-events.json',JSON.stringify({is_demo:true,coordinate_system:'WGS84',generated_for:date,source_url:source,events},null,2)+'\n');
console.log(`Exported ${events.length} seed events for ${date}; no database was modified.`);
