/** User policy: retain the record, explicitly exclude unavailable or unconfirmed
 * public visits; do not claim an unconfirmed venue has permanently shut down. */
export function applyAttractionStatusPolicy(value:Record<string,any>):boolean{
  if(value.record_type!=="attraction")return false;
  const internal=/内部专用|不对外开放/.test(value.venue_name??"");
  if(!["paused","unknown"].includes(value.status)&&!internal)return false;
  if(value.status==="paused"&&(value.time_note??"").includes("不开放："))return true;
  const reason=internal?"高德标注内部专用，暂不用于公众行程":value.status==="unknown"?"尚未确认正常开放，按项目规则暂不纳入规划，并非确认永久停业":"当前暂停开放，不纳入规划";
  const note=`不开放：${reason}`;value.status="paused";
  if(!(value.time_note??"").includes(note))value.time_note=[value.time_note,note].filter(Boolean).join("\n");return true;
}
