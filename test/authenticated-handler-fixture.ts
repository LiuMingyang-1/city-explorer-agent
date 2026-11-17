import {randomBytes} from 'node:crypto';
import {createChatHandler as productionHandler, type WebChatOptions} from '../src/web/http.ts';
import type {AuthStore} from '../src/web/auth.ts';
import type {ChatService} from '../src/web/types.ts';
import {mintUserId,readUserIdCookie,userIdSetCookie} from '../src/web/identity.ts';

// Protocol/service tests assume an authenticated caller. Auth policy itself is
// exercised through the unwrapped production handler in web-auth.test.ts.
// Keep their existing per-user IDs while supplying an explicit session fixture.
export function createChatHandler(service:ChatService,options:WebChatOptions={}){
 const sessions=new Map<string,string>();
 const auth={resolveSession:(token:string)=>{const userId=sessions.get(token);return userId?{userId,username:'fixture',displayName:null}:undefined;}} as AuthStore;
 const handler=productionHandler(service,{...options,auth});
 return (req:Parameters<typeof handler>[0],res:Parameters<typeof handler>[1])=>{
  const name=options.cookieName??'chat_uid';
  let uid=readUserIdCookie(req.headers.cookie,name);
  if(!uid){uid=(options.mintUserId??mintUserId)();res.setHeader('Set-Cookie',userIdSetCookie(name,uid));}
  const token=randomBytes(32).toString('hex');sessions.set(token,uid);
  req.headers.cookie=(req.headers.cookie?req.headers.cookie+'; ':'')+'chat_session='+token;
  return handler(req,res);
 };
}
