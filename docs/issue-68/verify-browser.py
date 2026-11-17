from playwright.sync_api import sync_playwright
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
import threading,functools,json
server=ThreadingHTTPServer(('127.0.0.1',8770),functools.partial(SimpleHTTPRequestHandler,directory='frontend'))
threading.Thread(target=server.serve_forever,daemon=True).start()
with sync_playwright() as p:
 browser=p.chromium.launch(channel='msedge',headless=True)
 context=browser.new_context(viewport={'width':1440,'height':900},record_video_dir='.local-data/issue-68-video')
 page=context.new_page();calls=[];identity={'authenticated':False}
 def api(route):
  path=route.request.url.split('/api/')[-1];calls.append((path,route.request.method))
  if path=='me':route.fulfill(json=identity)
  elif path=='login':identity.update(authenticated=True,user={'id':'browser-fixture','username':'tester','display_name':'测试账号'});route.fulfill(json={'user':identity['user']})
  elif path=='logout':identity.clear();identity['authenticated']=False;route.fulfill(status=204)
  elif path=='map-config':route.fulfill(json={'enabled':False})
  elif path=='memory':route.fulfill(json={'content':'','updated_at':None}) if identity['authenticated'] else route.fulfill(status=401,json={'error':'login required'})
  elif path.startswith('chat') and route.request.method=='POST':route.fulfill(json={'kind':'answer','text':'已收到登录后的请求（测试桩回复）','session_id':'browser-session'})
  elif path.startswith('events'):route.fulfill(json={'events':[]})
  else:route.fulfill(json={'messages':[]})
 page.route('**/api/**',api)
 page.goto('http://127.0.0.1:8770',wait_until='domcontentloaded');page.wait_for_function('!!window.WanderAuth')
 page.locator('#message-input').fill('周末想去看展')
 page.locator('#send-button').click();page.wait_for_timeout(400)
 assert not any(path.startswith('chat') and method=='POST' for path,method in calls)
 assert page.locator('#message-input').input_value()=='周末想去看展'
 assert page.locator('#auth-panel').is_visible()
 page.screenshot(path='docs/issue-68/guest-login-required.png')
 page.locator('#auth-username-input').fill('tester');page.locator('#auth-password-input').fill('fixture-only');page.locator('#auth-login').click()
 page.wait_for_function('window.WanderAuth.requireLogin()')
 assert page.locator('#message-input').input_value()=='周末想去看展'
 page.locator('#send-button').click();page.wait_for_timeout(700)
 assert sum(path.startswith('chat') and method=='POST' for path,method in calls)==1
 page.screenshot(path='docs/issue-68/logged-in-send.png')
 page.locator('#auth-open').click();page.locator('#auth-logout').click();page.wait_for_timeout(300)
 page.locator('#message-input').fill('退出后不能发送');page.locator('#send-button').click();page.wait_for_timeout(300)
 assert sum(path.startswith('chat') and method=='POST' for path,method in calls)==1
 page.screenshot(path='docs/issue-68/logged-out-blocked.png')
 video=page.video;context.close();video.save_as('docs/issue-68/login-guard.webm');browser.close()
 open('docs/issue-68/browser-results.json','w',encoding='utf-8').write(json.dumps({'environment':'Edge headless 1440x900; auth/chat API fixtures; real frontend scripts','checks':['guest send blocked','draft retained before login','draft retained after login','authenticated send accepted once','logout blocks subsequent send'],'requests':calls},ensure_ascii=False,indent=2))
server.shutdown()
print('Browser checks passed; screenshots and recording saved')
