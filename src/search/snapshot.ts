import { SearchRequestError } from "./types.ts";
import type { SearchResponse } from "./types.ts";
import type { Snapshot } from "./repository.ts";
export function makeSnapshot(response: SearchResponse, maxBytes = 65536): Snapshot {
 const pageEnds: number[]=[];
 let offset=0;
 do {
   let end=offset;
   while(end<response.results.length && end-offset<response.effective_request.limit) {
     const candidate={...response,results:response.results.slice(offset,end+1),effective_request:{...response.effective_request,cursor:"x".repeat(160)},next_cursor:"x".repeat(160),truncated:true};
     if(Buffer.byteLength(JSON.stringify(candidate))>maxBytes) break;
     end++;
   }
   if(end===offset && response.results.length>offset || Buffer.byteLength(JSON.stringify({...response,results:[],effective_request:{...response.effective_request,cursor:"x".repeat(160)},next_cursor:"x".repeat(160)}))>maxBytes) throw new SearchRequestError("RESPONSE_TOO_LARGE");
   pageEnds.push(end); offset=end;
 } while(offset<response.results.length);
 return {response,pageEnds};
}
export function snapshotPage(snapshot: Snapshot, offset: number, cursor: string | null): SearchResponse {
 const prior=snapshot.pageEnds.indexOf(offset);
 const index=offset===0 ? 0 : prior<0 ? -1 : prior+1;
 if(index<0 || index>=snapshot.pageEnds.length) throw new SearchRequestError("INVALID_CURSOR");
 return {...snapshot.response,results:snapshot.response.results.slice(offset,snapshot.pageEnds[index]),truncated:snapshot.response.truncated || cursor!==null,next_cursor:cursor};
}
