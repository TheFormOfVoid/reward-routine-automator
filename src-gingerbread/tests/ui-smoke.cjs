const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { inflateSync } = require('node:zlib');
const { browserOptions, browserName } = require('./browser-fixture.cjs');
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gingerbread-ui-check-'));
  const output = process.env.GINGERBREAD_UI_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'gingerbread-ui-evidence-'));
  fs.mkdirSync(output, {recursive: true});
  let context;
  try {
    const build = path.resolve(__dirname, '../dist');
    context = await chromium.launchPersistentContext(profile, browserOptions(build));
    context.setDefaultTimeout(15000);
    await context.route('https://**/*', route => route.fulfill({status:404,body:'offline fixture'}));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).hostname;
    async function checkRewardsLink(page) {
      const link=page.getByRole('link',{name:'Open Bing Rewards',exact:true});
      assert.equal(await link.getAttribute('href'),'https://rewards.bing.com/dashboard');
      const opened=context.waitForEvent('page');
      await link.click();
      const rewards=await opened;
      await rewards.waitForURL('https://rewards.bing.com/dashboard');
      assert.ok((await worker.evaluate(()=>chrome.windows.getAll())).every(window=>window.type==='normal'));
      await rewards.close();
    }
    async function waitLayout(test, message) {
      const until=Date.now()+10000;
      while(Date.now()<until){const state=await worker.evaluate(()=>chrome.storage.local.get(['popupWidgetLayout','dashHiddenWidgets','dashLayout']));if(test(state))return;await new Promise(resolve=>setTimeout(resolve,50))}
      throw Error(message);
    }
    async function checkBlur(locator, pixels, surface) {
      await locator.first().waitFor();
      await expect.poll(async()=>{
        const filter=await locator.first().evaluate(element=>getComputedStyle(element).backdropFilter);
        const match=filter.match(/blur\(([\d.]+)px\)/);
        return match ? Number(match[1]) : filter==='none' ? 0 : NaN;
      },{message:`${surface} follows Glass blur`}).toBe(pixels);
    }
    async function checkBarrier(bar, visible, surface) {
      const pseudo=bar==='top'?'::before':'::after';
      await expect(popup.locator('.app')).toHaveAttribute(`data-${bar}-bar-background`,String(visible));
      const state=await popup.locator('.app').evaluate((app,pseudo)=>{
        const style=getComputedStyle(app,pseudo),bounds=app.getBoundingClientRect();
        const probe=document.createElement('span');probe.style.backgroundColor='var(--bg)';app.append(probe);
        const expected=getComputedStyle(probe).backgroundColor;probe.remove();
        return {background:style.backgroundColor,expected,filter:style.backdropFilter,image:style.backgroundImage,
          content:style.content,display:style.display,visibility:style.visibility,opacity:Number(style.opacity),
          width:parseFloat(style.width),height:parseFloat(style.height),top:parseFloat(style.top),bottom:parseFloat(style.bottom),
          appWidth:bounds.width,topClearance:app.querySelector('.topbar').getBoundingClientRect().bottom-bounds.top,
          bottomClearance:bounds.bottom-(app.querySelector('.tabbar')?.getBoundingClientRect().top??bounds.bottom)};
      },pseudo);
      const rendered=state.content!=='none'&&state.content!=='normal'&&state.display!=='none'&&state.visibility!=='hidden'&&state.opacity>0;
      if(visible){
        assert.ok(rendered,`${surface} renders a backing strip`);
        assert.equal(state.opacity,1,`${surface} has full opacity`);
        assert.equal(state.background,state.expected,`${surface} uses the opaque app background`);
        assert.ok(!state.background.startsWith('rgba(')||state.background.endsWith(', 1)'),`${surface} is opaque`);
        assert.ok(state.width>=state.appWidth-1,`${surface} spans the full popup width`);
        assert.ok(state.height>=(bar==='top'?state.topClearance:state.bottomClearance)-1,`${surface} covers the bar and its outer margin`);
        assert.equal(bar==='top'?state.top:state.bottom,0,`${surface} reaches the popup edge`);
      }else{
        assert.ok(!rendered||state.background==='rgba(0, 0, 0, 0)',`${surface} clears the backing strip`);
      }
      assert.equal(state.filter,'none',`${surface} is independent of Glass blur`);
      assert.equal(state.image,'none',`${surface} has no backing image`);
      return state;
    }
    async function chromePaint() {
      return popup.locator('.topbar,.tabbar,.tabbar .tab').evaluateAll(elements=>elements.map(element=>{
        const style=getComputedStyle(element);
        return {background:style.backgroundColor,image:style.backgroundImage,filter:style.backdropFilter,shadow:style.boxShadow,border:style.borderColor};
      }));
    }
    async function checkEditing(editing) {
      await expect(popup.getByRole('button',{name:'Customize widgets',exact:true})).toHaveAttribute('aria-pressed',String(editing));
      await expect(popup.getByRole('button',{name:'Add widgets',exact:true})).toHaveCount(editing?1:0);
      await expect(popup.getByRole('button',{name:'Done editing',exact:true})).toHaveCount(editing?1:0);
      await expect(popup.locator('.today-toolbar')).toHaveCount(editing?1:0);
      if(!editing)await expect(popup.locator('.widget-controls,.widget-edit-note')).toHaveCount(0);
    }
    async function screenshotPixel(x,y) {
      const png=await popup.screenshot({clip:{x:Math.floor(x),y:Math.floor(y),width:1,height:1},scale:'css',animations:'disabled'});
      assert.equal(png.readUInt32BE(16),1);assert.equal(png.readUInt32BE(20),1);
      assert.equal(png[24],8);assert.ok([2,6].includes(png[25]),'RGB screenshot pixel');
      const chunks=[];
      for(let offset=8;offset<png.length;){const length=png.readUInt32BE(offset),type=png.toString('ascii',offset+4,offset+8);if(type==='IDAT')chunks.push(png.subarray(offset+8,offset+8+length));offset+=length+12}
      // This is the first pixel of the first row, so every PNG row filter has
      // zero-valued left/up predictors and leaves its channels unchanged.
      const row=inflateSync(Buffer.concat(chunks));
      return [...row.subarray(1,4)];
    }
    async function checkContentUnderBars() {
      for(const bar of ['top','bottom']){
        const samples=[];
        for(const visible of [false,true]){
          await popupBackgrounds(bar==='top'&&visible,bar==='bottom'&&visible);
          const barrier=await checkBarrier(bar,visible,`${bar} rendered backing`);
          const card=popup.locator('[data-widget-id] .card')[bar==='top'?'first':'last']();
          const original=await card.getAttribute('style');
          const childStyles=await card.evaluate(element=>[...element.children].map(child=>child.getAttribute('style')));
          try{
            // Paint a real widget without changing its dimensions. The probe
            // remains inside the actual scrolling content and stacking order.
            await card.evaluate(element=>{
              for(const [key,value] of Object.entries({background:'rgb(255, 0, 255)',backgroundImage:'none',borderRadius:'0',boxShadow:'none',backdropFilter:'none'}))element.style.setProperty(key.replace(/[A-Z]/g,letter=>`-${letter.toLowerCase()}`),value,'important');
              for(const child of element.children)child.style.setProperty('visibility','hidden','important');
            });
            const position=await card.evaluate((element,bar)=>{
              const app=document.querySelector('.app').getBoundingClientRect(),stage=document.querySelector('.stage'),before=element.getBoundingClientRect();
              const wantedTop=bar==='top'?app.top-12:app.bottom-before.height+12;
              stage.scrollTop+=before.top-wantedTop;
              const bounds=element.getBoundingClientRect(),viewport=stage.getBoundingClientRect();
              const x=Math.floor(bounds.left+bounds.width/2),y=Math.floor(bar==='top'?app.top+4:app.bottom-4);
              return {x,y,top:bounds.top,bottom:bounds.bottom,stageTop:viewport.top,stageBottom:viewport.bottom,scrollTop:stage.scrollTop};
            },bar);
            assert.ok(position.scrollTop>0,`${bar} probe uses scrolled content`);
            assert.ok(position.top<position.y&&position.bottom>position.y,`Actual widget passes behind the ${bar} bar`);
            assert.ok(position.stageTop<=position.y&&position.stageBottom>position.y,`${bar} region belongs to the scroll viewport`);
            assert.equal(await card.evaluate((element,{x,y})=>element.contains(document.elementFromPoint(x,y)),position),!visible,`${bar} backing also controls whether covered content receives pointer input`);
            const pixel=await screenshotPixel(position.x,position.y);samples.push(pixel);
            // Retained floating glass casts a subtle outer shadow even in the
            // outer gap. Allow that paint while distinguishing opaque app fill
            // from the bright marker beneath it.
            if(visible){
              const expected=barrier.expected.match(/[\d.]+/g).slice(0,3).map(Number);
              assert.ok(pixel.every((channel,index)=>Math.abs(channel-expected[index])<=3),`${bar} strip visibly covers content with the app background: ${pixel}`);
            }else assert.ok(pixel[0]>220&&pixel[1]<30&&pixel[2]>220,`Cleared ${bar} strip visibly reveals the scrolled widget: ${pixel}`);
          }finally{
            await card.evaluate((element,{original,childStyles})=>{
              if(original===null)element.removeAttribute('style');else element.setAttribute('style',original);
              [...element.children].forEach((child,index)=>{if(childStyles[index]===null)child.removeAttribute('style');else child.setAttribute('style',childStyles[index])});
            },{original,childStyles});
          }
        }
        assert.notDeepEqual(samples[0],samples[1],`${bar} switch changes actual content obstruction`);
      }
      await popupBackgrounds(true,false);
    }
    async function setSwitch(page, label, key, checked) {
      const control=page.getByRole('switch',{name:label,exact:true});
      if(await control.getAttribute('aria-checked')!==String(checked))await control.click();
      await expect(control).toHaveAttribute('aria-checked',String(checked));
      await page.waitForFunction(async({key,checked})=>(await chrome.storage.sync.get('settings')).settings[key]===checked,{key,checked});
    }
    async function popupBackgrounds(top, bottom) {
      await popup.getByRole('button',{name:'Settings',exact:true}).click();
      await setSwitch(popup,'Top bar background','topBarBackground',top);
      await setSwitch(popup,'Bottom bar background','bottomBarBackground',bottom);
      await popup.getByRole('button',{name:'Back',exact:true}).click();
      await popup.locator('[data-widget-id="balance"] .card').waitFor();
      await expect(popup.locator('.today-view')).toHaveCSS('opacity','1');
    }
    async function chromeGeometry() {
      return popup.locator('.topbar,.tabbar,.tabbar .tab,.stage').evaluateAll(elements=>elements.map(element=>{
        const {x,y,width,height}=element.getBoundingClientRect();return{x,y,width,height};
      }));
    }
    async function changeGlassBlur(pixels) {
      await popup.getByRole('button',{name:'Settings',exact:true}).click();
      const slider=popup.getByRole('slider',{name:'Glass blur',exact:true});
      await slider.focus();
      await slider.press(pixels===30 ? 'End' : 'Home');
      if(pixels>0&&pixels<30){
        await popup.waitForFunction(async()=>(await chrome.storage.sync.get('settings')).settings.tileBlur===0);
        // Hold the arrow key through the local changes, then commit once on
        // key-up, just as a user adjusting this range with the keyboard can.
        for(let n=0;n<pixels;n++)await popup.keyboard.down('ArrowRight');
        await popup.keyboard.up('ArrowRight');
      }
      assert.equal(await slider.inputValue(),String(pixels));
      await popup.waitForFunction(async expected=>(await chrome.storage.sync.get('settings')).settings.tileBlur===expected,pixels);
      await checkBlur(popup.locator('.topbar'),pixels,'Settings header');
      await checkBlur(slider.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " card ")][1]'),pixels,'Settings card');
      await popup.getByRole('button',{name:'Back',exact:true}).click();
      await popup.locator('[data-widget-id="balance"] .card').waitFor();
      await checkBlur(popup.locator('.topbar'),pixels,'Today header');
      await checkBlur(popup.locator('[data-widget-id="balance"] .card'),pixels,'Today widget');
      await checkBlur(popup.locator('.tabbar .tab:not(.active)'),pixels,'Navigation button');
      await checkBarrier('top',true,`Top backing at ${pixels}px blur`);
      await checkBarrier('bottom',true,`Bottom backing at ${pixels}px blur`);
    }
    await worker.evaluate(async () => {
      const {settings} = await chrome.storage.sync.get('settings');
      await chrome.storage.sync.set({settings:{...settings,startupEnabled:false,randomSearchEnabled:false,scheduledRunEnabled:false,refreshStatsOnPopupOpen:false,background:'cursor',animationsEnabled:true,lowPowerMode:false,mouseEscapeEnabled:false,appearance:'dark'}});
      await chrome.storage.local.set({pointsHistory:[{day:'2026-10-27',first:50,last:150,at:99},{day:'2026-10-28',first:100,last:250,at:100}],lastOrders:{at:100,total:1,orders:[{title:'coins',orderNo:'one',code:'PRIVATE_CODE'}]},
        lastStats:{at:Date.now(),availablePoints:250,activities:{bingApp:'0/1'}},redeemRestockNews:{at:100,labels:['500 coins']},redeemSoldOutNews:{at:101,labels:['2000 coins']}});
    });
    const errors=[];
    const popup = await context.newPage();
    popup.on('pageerror',error=>errors.push(error.message));
    await popup.setViewportSize({width:440,height:600});
    await popup.goto(`chrome-extension://${id}/index.html`);
    const noticeNames=['Bing app','restock','sold-out'];
    for (const name of noticeNames) await popup.getByRole('button',{name:`Dismiss ${name} notification`,exact:true}).waitFor();
    assert.ok(await popup.locator('.notice').evaluateAll(cards=>cards.every(card=>card.getBoundingClientRect().width<=344&&card.scrollWidth<=card.clientWidth)));
    await popup.screenshot({path:path.join(output,'compact-notifications.png')});
    await checkRewardsLink(popup);
    await popup.getByRole('button',{name:'Dismiss Bing app notification',exact:true}).focus();
    await popup.keyboard.press('Enter');
    for (const name of ['restock','sold-out']) await popup.getByRole('button',{name:`Dismiss ${name} notification`,exact:true}).click();
    const acknowledgements=await worker.evaluate(()=>chrome.storage.local.get(['dismissedNotice:bingApp','dismissedNotice:restock','dismissedNotice:soldOut']));
    assert.equal(Object.keys(acknowledgements).length,3);
    await popup.reload();
    await popup.locator('.brand-glyph').waitFor();
    assert.equal(await popup.locator('.notice').count(),0);
    await worker.evaluate(()=>chrome.storage.local.set({redeemRestockNews:{at:102,labels:['500 coins','1000 coins']}}));
    await popup.getByRole('button',{name:'Dismiss restock notification',exact:true}).waitFor();
    assert.equal(await popup.locator('.notice').count(),1,'New news appears after an earlier dismissal');
    await popup.getByRole('button',{name:'Dismiss restock notification',exact:true}).click();
    assert.deepEqual((await worker.evaluate(()=>chrome.storage.local.get('redeemRestockNews'))).redeemRestockNews,{at:102,labels:['500 coins','1000 coins']});
    const liveAcknowledgements=await worker.evaluate(()=>chrome.storage.local.get(['dismissedNotice:bingApp','dismissedNotice:restock','dismissedNotice:soldOut']));
    await worker.evaluate(async()=>{const{settings}=await chrome.storage.sync.get('settings');await chrome.storage.sync.set({settings:{...settings,developerOptionsEnabled:true}})});
    await popup.getByRole('button',{name:'Preview every banner',exact:true}).click();
    for (const name of noticeNames) await popup.getByRole('button',{name:`Dismiss ${name} notification`,exact:true}).waitFor();
    assert.ok(await popup.locator('.topbar').evaluate(e=>e.scrollWidth<=e.clientWidth),'Developer toolbar fits with the new shortcut');
    await expect.poll(()=>popup.locator('.notice').first().evaluate(element=>element.getBoundingClientRect().top>=document.querySelector('.topbar').getBoundingClientRect().bottom),{message:'Wrapped developer header leaves the first notice reachable'}).toBe(true);
    await popup.getByRole('button',{name:'Dismiss Bing app notification',exact:true}).click();
    assert.deepEqual(await worker.evaluate(()=>chrome.storage.local.get(['dismissedNotice:bingApp','dismissedNotice:restock','dismissedNotice:soldOut'])),liveAcknowledgements,'Preview dismissal does not change real acknowledgements');
    await popup.getByRole('button',{name:'Preview every banner',exact:true}).click();
    assert.equal(await popup.locator('.notice').count(),0);
    await popup.getByRole('button',{name:'Preview every banner',exact:true}).click();
    await popup.getByRole('button',{name:'Dismiss Bing app notification',exact:true}).waitFor();
    await popup.getByRole('button',{name:'Preview every banner',exact:true}).click();
    const update=await context.newPage();
    await update.addInitScript(()=>{window.__diskVersion='6.99.1';const original=window.fetch.bind(window);window.fetch=(input,options)=>String(input).endsWith('/manifest.json')?Promise.resolve(new Response(JSON.stringify({version:window.__diskVersion}),{status:200})):original(input,options)});
    await update.goto(`chrome-extension://${id}/index.html`);
    await update.getByRole('button',{name:'Dismiss update notification',exact:true}).click();
    assert.equal((await worker.evaluate(()=>chrome.storage.local.get('dismissedNotice:update')))['dismissedNotice:update'],'6.99.1');
    await update.reload();
    await update.locator('.brand-glyph').waitFor();
    assert.equal(await update.getByRole('button',{name:'Dismiss update notification',exact:true}).count(),0);
    await update.evaluate(()=>{window.__diskVersion='6.99.2';window.dispatchEvent(new Event('focus'))});
    await update.getByRole('button',{name:'Dismiss update notification',exact:true}).waitFor();
    await update.close();
    await worker.evaluate(async()=>{const{settings}=await chrome.storage.sync.get('settings');await chrome.storage.sync.set({settings:{...settings,developerOptionsEnabled:false}})});
    await popup.getByRole('navigation').getByRole('button',{name:'Today',exact:true}).click();
    await worker.evaluate(()=>chrome.storage.local.set({lastStats:{at:Date.now(),availablePoints:250,searchPoints:'60/60',activities:{bingSearch:'Day 4 of 7 · 1/1',dailySet:'Day 3 of 7 · 0/3',bingApp:'Day 2 of 7 · 0/1',visualSearch:'Day 0 of 7 · 0/1'}}}));
    const streakWidget=popup.locator('[data-widget-id="streaks"]');
    await streakWidget.locator('.streak-week').first().waitFor();
    assert.equal(await streakWidget.locator('.streak-week').count(),4);
    assert.equal(await streakWidget.locator('.streak-week').first().getByRole('listitem').count(),7);
    assert.equal(await streakWidget.locator('.streak-week').first().locator('[data-state="completed"]').count(),4);
    assert.equal(await streakWidget.locator('.streak-week').nth(1).locator('[data-state="pending"]').count(),1);
    assert.equal(await streakWidget.locator('.streak-week-days,.streak-week-note').count(),0,'Streak rails omit visual day numbers and the explanatory footer');
    assert.match(await streakWidget.getByRole('listitem').first().getAttribute('aria-label'),/Day 1: Completed/,'Segment meaning remains accessible');
    assert.ok(await streakWidget.locator('[data-state="completed"]').evaluateAll(segments=>segments.every(segment=>segment.textContent.trim()==='')),'Completed green segments have no check text');
    await expect(popup.getByText('Your day',{exact:true})).toHaveCount(0);
    await expect(popup.locator('.today-view time,.today-date')).toHaveCount(0);
    const customize=popup.getByRole('button',{name:'Customize widgets',exact:true});
    assert.equal((await customize.textContent()).trim(),'','Customize widgets is an icon-only toolbar button');
    assert.ok(await customize.locator('svg').count()>0,'Customize widgets retains an icon');
    await checkEditing(false);
    await checkBarrier('top',false,'Default cleared top backing');
    await checkBarrier('bottom',false,'Default cleared bottom backing');
    await expect(popup.locator('.today-view')).toHaveCSS('opacity','1');
    await expect(popup.locator('[data-widget-id="balance"] .hero-value')).toHaveText('250');
    await popup.screenshot({path:path.join(output,'redesigned-popup.png')});
    await popup.getByRole('button',{name:'Settings',exact:true}).click();
    await expect(popup.getByRole('switch',{name:'Top bar background',exact:true})).toHaveAttribute('aria-checked','false');
    await expect(popup.getByRole('switch',{name:'Bottom bar background',exact:true})).toHaveAttribute('aria-checked','false');
    await setSwitch(popup,'Top bar background','topBarBackground',true);
    await setSwitch(popup,'Bottom bar background','bottomBarBackground',true);
    await popup.getByRole('button',{name:'Back',exact:true}).click();
    for(const pixels of [0,8,30])await changeGlassBlur(pixels);
    const frosted=await popup.locator('[data-widget-id="balance"] .card').evaluate(element=>getComputedStyle(element).backgroundColor);
    await changeGlassBlur(0);
    assert.equal(await popup.locator('[data-widget-id="balance"] .card').evaluate(element=>getComputedStyle(element).backgroundColor),'rgba(0, 0, 0, 0)','Zero blur clears widget tint');
    assert.notEqual(frosted,'rgba(0, 0, 0, 0)','Frosted setting also supplies a translucent tint');
    await changeGlassBlur(8);
    await popup.reload();
    await checkBlur(popup.locator('[data-widget-id="balance"] .card'),8,'Reopened Today widget');
    await checkBlur(popup.locator('.topbar'),8,'Reopened header');
    const dock=await popup.locator('.tabbar').evaluate(element=>{const style=getComputedStyle(element);return{background:style.backgroundColor,filter:style.backdropFilter,shadow:style.boxShadow,height:element.getBoundingClientRect().height}});
    assert.equal(dock.background,'rgba(0, 0, 0, 0)','Navigation has no content-hiding backing panel');
    assert.equal(dock.filter,'none','Only the navigation buttons frost the backdrop');
    assert.equal(dock.shadow,'none','Navigation has no full-width backing shadow');
    assert.ok(dock.height<=56,'Bottom navigation is more compact');
    const originalGeometry=await chromeGeometry();
    const originalPaint=await chromePaint();
    await popupBackgrounds(false,true);
    await checkBarrier('top',false,'Cleared top backing with bottom backing shown');
    await checkBarrier('bottom',true,'Bottom backing remains shown');
    assert.deepEqual(await chromePaint(),originalPaint,'Backing switches preserve the floating header and button glass');
    await popup.emulateMedia({contrast:'more'});
    await checkBarrier('top',false,'Contrast preference preserves cleared top backing');
    await checkBarrier('bottom',true,'Contrast preference preserves opaque bottom backing');
    await checkBlur(popup.locator('.topbar'),0,'Contrast preference simplifies floating header');
    await checkBlur(popup.locator('.tabbar .tab:not(.active)'),0,'Contrast preference simplifies navigation buttons');
    await popup.emulateMedia({contrast:'no-preference'});
    await checkBlur(popup.locator('.topbar'),8,'Header blur resumes after contrast preference');
    await checkBlur(popup.locator('.tabbar .tab:not(.active)'),8,'Button blur resumes after contrast preference');
    assert.deepEqual(await chromeGeometry(),originalGeometry,'Background visibility preserves control and content geometry');
    await popup.getByRole('navigation').getByRole('button',{name:'Activity',exact:true}).click();
    await expect(popup.getByRole('navigation').getByRole('button',{name:'Activity',exact:true})).toHaveAttribute('aria-current','true');
    await customize.click();
    await expect(popup.getByRole('navigation').getByRole('button',{name:'Today',exact:true})).toHaveAttribute('aria-current','true');
    await checkEditing(true);
    await customize.click();
    await checkEditing(false);
    await popup.reload();
    await checkBarrier('top',false,'Reopened cleared top backing');
    await checkBarrier('bottom',true,'Reopened bottom backing');
    await checkBlur(popup.locator('.topbar'),8,'Reopened floating header');
    await checkBlur(popup.locator('.tabbar .tab:not(.active)'),8,'Reopened floating navigation buttons');
    await popup.getByRole('button',{name:'Settings',exact:true}).click();
    await expect(popup.getByRole('switch',{name:'Top bar background',exact:true})).toHaveAttribute('aria-checked','false');
    await expect(popup.getByRole('switch',{name:'Bottom bar background',exact:true})).toHaveAttribute('aria-checked','true');
    await setSwitch(popup,'Top bar background','topBarBackground',true);
    await popup.getByRole('button',{name:'Back',exact:true}).click();
    await checkBarrier('top',true,'Independently shown top backing');
    await checkBarrier('bottom',true,'Bottom backing remains shown');
    assert.deepEqual(await chromePaint(),originalPaint,'Showing both backings preserves floating glass');
    await expect(popup.locator('.today-view')).toHaveCSS('opacity','1');
    await popup.screenshot({path:path.join(output,'bar-backgrounds-visible.png')});
    await popupBackgrounds(true,false);
    await checkBarrier('top',true,'Top backing remains shown');
    await checkBarrier('bottom',false,'Independently cleared bottom backing');
    assert.deepEqual(await chromePaint(),originalPaint,'Clearing bottom backing preserves floating glass');
    assert.deepEqual(await chromeGeometry(),originalGeometry,'Toggling backgrounds keeps the same layout');
    await checkContentUnderBars();
    const stage=popup.locator('.stage');
    assert.equal(await stage.evaluate(element=>getComputedStyle(element).scrollbarWidth),'none','Popup scrollbar chrome is hidden');
    assert.ok(await stage.evaluate(element=>element.scrollHeight>element.clientHeight),'Today still has scrollable content');
    await stage.evaluate(element=>{element.scrollTop=0});
    assert.ok(await popup.locator('[data-widget-id]').first().evaluate(element=>element.getBoundingClientRect().top>=document.querySelector('.topbar').getBoundingClientRect().bottom),'First widget starts below the floating header');
    await stage.evaluate(element=>{element.scrollTop=element.scrollHeight});
    assert.ok(await popup.locator('[data-widget-id]').last().evaluate(element=>element.getBoundingClientRect().bottom<=document.querySelector('.tabbar').getBoundingClientRect().top),'Last widget can scroll fully above the floating navigation');
    await stage.evaluate(element=>{element.scrollTop=0});
    await stage.hover();
    await popup.mouse.wheel(0,180);
    await popup.waitForFunction(()=>document.querySelector('.stage').scrollTop>0);
    await stage.evaluate(element=>{element.scrollTop=0});
    await stage.focus();
    await stage.evaluate(element=>{
      window.__keyboardScrollEnd=new Promise(resolve=>element.addEventListener('scrollend',()=>resolve(true),{once:true}));
    });
    await popup.keyboard.press('PageDown');
    await popup.waitForFunction(()=>document.querySelector('.stage').scrollTop>0);
    await stage.evaluate(element=>element.blur());
    await expect(popup.locator('.today-view')).toHaveCSS('opacity','1');
    await customize.click();
    await checkEditing(true);
    await popup.evaluate(()=>window.__keyboardScrollEnd);
    assert.ok(await popup.locator('.today-toolbar').evaluate(element=>{
      const rect=element.getBoundingClientRect(),app=document.querySelector('.app');
      const expectedTop=app.getBoundingClientRect().top+parseFloat(getComputedStyle(app).getPropertyValue('--popup-top-clearance'));
      return Math.abs(rect.top-expectedTop)<=1&&rect.top>=document.querySelector('.topbar').getBoundingClientRect().bottom&&rect.bottom<document.querySelector('.tabbar').getBoundingClientRect().top;
    }),'Editor actions stay visible after native keyboard scrolling completes');
    await popup.screenshot({path:path.join(output,'widget-edit-mode.png')});
    const lastWidgetAction=popup.locator('.widget-controls button:not([disabled])').last();
    await lastWidgetAction.focus();
    assert.ok(await lastWidgetAction.evaluate(element=>element.getBoundingClientRect().bottom<=document.querySelector('.tabbar').getBoundingClientRect().top),'Focused widget controls remain above the floating navigation');
    const firstWidgetAction=popup.locator('.widget-controls button:not([disabled])').first();
    await firstWidgetAction.focus();
    assert.ok(await firstWidgetAction.evaluate(element=>element.getBoundingClientRect().top>=document.querySelector('.topbar').getBoundingClientRect().bottom),'Focused widget controls remain below the floating header');
    assert.ok(await firstWidgetAction.evaluate(element=>element.getBoundingClientRect().top>=document.querySelector('.today-toolbar').getBoundingClientRect().bottom),'Focused widget controls remain below the editor actions');
    await popup.getByRole('combobox',{name:"Size of Today's streaks",exact:true}).selectOption('compact');
    await waitLayout(state=>state.popupWidgetLayout?.items.some(item=>item.id==='streaks'&&item.size==='compact'),'Popup widget size not saved');
    await popup.getByRole('button',{name:'Remove Points history',exact:true}).click();
    await waitLayout(state=>!state.popupWidgetLayout?.items.some(item=>item.id==='history'),'Popup widget removal not saved');
    await popup.reload();
    await popup.locator('[data-widget-id="streaks"].popup-widget--compact').waitFor();
    assert.equal(await popup.locator('[data-widget-id="history"]').count(),0);
    await checkEditing(false);
    await customize.click();
    await checkEditing(true);
    await popup.getByRole('button',{name:'Add widgets',exact:true}).click();
    const todayChooser=popup.getByRole('dialog',{name:'Today widgets',exact:true});
    await todayChooser.getByLabel('Points history',{exact:true}).check();
    await todayChooser.getByRole('button',{name:'Close',exact:true}).click();
    await popup.locator('[data-widget-id="history"] .history-chart').waitFor();
    await popup.getByRole('button',{name:'Add widgets',exact:true}).click();
    for(const label of ['Balance',"Today's streaks",'Points history','Points goal','Next routine'])await todayChooser.getByLabel(label,{exact:true}).uncheck();
    await todayChooser.getByRole('button',{name:'Close',exact:true}).click();
    await waitLayout(state=>state.popupWidgetLayout?.items.length===0,'Explicit empty popup layout not saved');
    await popup.getByRole('heading',{name:'Make room for what matters'}).waitFor();
    await popup.getByRole('button',{name:'Done editing',exact:true}).click();
    await checkEditing(false);
    await popup.reload();
    await popup.getByRole('heading',{name:'Make room for what matters'}).waitFor();
    await checkEditing(false);
    await customize.click();
    await checkEditing(true);
    await popup.getByRole('button',{name:'Reset layout',exact:true}).click();
    await waitLayout(state=>!state.popupWidgetLayout,'Popup default layout not restored');
    await popup.getByRole('button',{name:'Done editing',exact:true}).click();
    await checkEditing(false);
    await popup.getByRole('button',{name:'Settings',exact:true}).click();
    await popup.getByRole('heading',{name:'Backup and restore',exact:true}).waitFor();
    const downloadEvent=popup.waitForEvent('download');
    await popup.getByRole('button',{name:'Export backup',exact:true}).click();
    const download=await downloadEvent;
    await download.saveAs(path.join(output,'fixture-backup.json'));
    const backup=JSON.parse(fs.readFileSync(path.join(output,'fixture-backup.json'),'utf8'));
    assert.equal(backup.data.lastOrders,undefined);
    assert.equal(backup.settings.background,'cursor');
    assert.equal(backup.settings.topBarBackground,true);
    assert.equal(backup.settings.bottomBarBackground,false);
    backup.settings.redeemGoalPts=9999;
    backup.settings.topBarBackground=false;
    backup.settings.bottomBarBackground=true;
    backup.data.pointsHistory=[{day:'2026-10-28',first:0,last:1,at:1},{day:'2026-10-27',first:10,last:20,at:1}];
    // A download can complete before React commits the end of Export's busy
    // state. Use the real button so Playwright waits for actionability instead
    // of bypassing its disabled state through the hidden input.
    const chooseEvent=popup.waitForEvent('filechooser');
    await popup.getByRole('button',{name:'Choose backup',exact:true}).click();
    const chooser=await chooseEvent;
    await chooser.setFiles({name:'restore.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
    try { await popup.getByRole('heading',{name:'Review restore'}).waitFor() }
    catch (error) {
      console.error('Backup import did not reach review',await popup.locator('.backup-card').evaluate(card=>({
        error:card.querySelector('.backup-error')?.textContent,
        message:card.querySelector('.backup-message')?.textContent,
        buttons:[...card.querySelectorAll('button')].map(button=>({label:button.textContent,disabled:button.disabled})),
      })));
      throw error;
    }
    await popup.getByRole('button',{name:'Restore reviewed backup',exact:true}).click();
    await popup.getByRole('status').filter({hasText:'Backup restored.'}).waitFor();
    const restored=await worker.evaluate(async()=>({sync:await chrome.storage.sync.get('settings'),local:await chrome.storage.local.get(['pointsHistory','lastOrders','gingerbreadBeforeRestore'])}));
    assert.equal(restored.sync.settings.redeemGoalPts,9999);
    assert.equal(restored.sync.settings.topBarBackground,false);
    assert.equal(restored.sync.settings.bottomBarBackground,true);
    assert.equal(restored.local.pointsHistory.find(day=>day.day==='2026-10-28').last,250);
    assert.equal(restored.local.lastOrders.orders[0].code,'PRIVATE_CODE');
    assert.ok(restored.local.gingerbreadBeforeRestore);
    await popup.getByRole('heading',{name:'Backup and restore'}).scrollIntoViewIfNeeded();
    await popup.screenshot({path:path.join(output,'backup-settings.png')});
    await popup.getByRole('button',{name:'Back',exact:true}).click();
    await checkBarrier('top',false,'Restored cleared top backing');
    await checkBarrier('bottom',true,'Restored bottom backing');
    await checkBlur(popup.locator('.topbar'),8,'Restored floating header');
    await checkBlur(popup.locator('.tabbar .tab:not(.active)'),8,'Restored floating navigation buttons');
    const finish=await context.newPage();
    finish.on('pageerror',error=>errors.push(error.message));
    await finish.addInitScript(()=>{const original=window.fetch.bind(window);window.fetch=(input,options)=>String(input).endsWith('/manifest.json')?Promise.resolve(new Response(JSON.stringify({version:'6.99.3'}),{status:200})):original(input,options)});
    await finish.setViewportSize({width:1100,height:780});
    await finish.goto(`chrome-extension://${id}/dashboard.html?dev=1&q=claim:unverified;keepEarning:unverified`);
    await finish.getByRole('dialog').waitFor();
    await finish.getByRole('button',{name:'Restart',exact:true}).waitFor();
    assert.equal(await finish.locator('.bg').count(),1);
    assert.equal(await finish.locator('.dash-gear').count(),0);
    assert.equal(await finish.locator('.finish-glyph').count(),0);
    assert.equal(await finish.evaluate(()=>document.activeElement?.textContent),'Done');
    await finish.keyboard.press('Tab');
    assert.equal(await finish.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Open Bing Rewards');
    await finish.keyboard.press('Shift+Tab');
    assert.equal(await finish.evaluate(()=>document.activeElement?.textContent),'Done');
    await checkRewardsLink(finish);
    for(const width of [320,380,768,1024,1440]){
      await finish.setViewportSize({width,height:780});
      assert.ok(await finish.locator('.finish-actions').evaluate(e=>e.scrollWidth<=e.clientWidth),'Finish actions fit narrow screens');
    }
    await finish.setViewportSize({width:1100,height:780});
    await finish.screenshot({path:path.join(output,'finish-one-background.png')});
    await finish.getByRole('button',{name:'Done',exact:true}).click();
    await finish.locator('.dash-gear').waitFor();
    await finish.locator('.dash-panel').first().waitFor();
    await checkBlur(finish.locator('.dash-panel'),8,'Dashboard widget');
    await checkBlur(finish.locator('.dash-edit-bar'),8,'Dashboard controls');
    assert.equal(await finish.locator('html').evaluate(element=>getComputedStyle(element).scrollbarWidth),'none','Dashboard scrollbar chrome is hidden');
    assert.equal(await finish.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Settings');
    await checkRewardsLink(finish);
    const controls=finish.locator('[data-panel-id="controls"]');
    await finish.getByRole('button',{name:'Add widgets',exact:true}).click();
    const dashboardChooser=finish.getByRole('dialog',{name:'Dashboard widgets',exact:true});
    await dashboardChooser.getByLabel("Today's streaks",{exact:true}).uncheck();
    await dashboardChooser.getByRole('button',{name:'Close',exact:true}).click();
    await waitLayout(state=>state.dashHiddenWidgets?.includes('streaks'),'Dashboard hide not saved');
    await finish.locator('[data-panel-id="streaks"]').waitFor({state:'hidden'});
    await finish.getByRole('button',{name:'Add widgets',exact:true}).click();
    await dashboardChooser.getByLabel("Today's streaks",{exact:true}).check();
    await dashboardChooser.getByRole('button',{name:'Close',exact:true}).click();
    await finish.locator('[data-panel-id="streaks"]').waitFor();
    await finish.getByRole('button',{name:'Edit layout',exact:true}).click();
    const size=controls.getByRole('combobox',{name:'Size of Run controls',exact:true});
    const nextSize=await size.locator('option').nth(1).getAttribute('value');
    await size.selectOption(nextSize);
    await waitLayout(state=>state.dashLayout?.items.some(item=>item.i==='controls'&&`${item.w}x${item.h}`===nextSize),'Dashboard resize not saved');
    await finish.getByRole('button',{name:'Default layout',exact:true}).click();
    await finish.getByRole('button',{name:'Done',exact:true}).click();
    assert.ok(await controls.locator('.dash-panel-body').evaluate(e=>e.scrollHeight<=e.clientHeight+1),'Smallest dashboard controls fit without scrolling');
    await controls.getByRole('button',{name:'More controls',exact:true}).click();
    await finish.getByRole('dialog',{name:'Routine controls',exact:true}).waitFor();
    assert.equal(await finish.evaluate(()=>document.activeElement?.textContent),'Close');
    await finish.keyboard.press('Escape');
    assert.equal(await finish.evaluate(()=>document.activeElement?.textContent),'More controls');
    for (const width of [380,768,1100,1440]) {
      await finish.setViewportSize({width,height:780});
      for (const automatic of [true,false]) {
        await worker.evaluate(async automatic=>{const{settings}=await chrome.storage.sync.get('settings');await chrome.storage.sync.set({settings:{...settings,rightSizeSearchBatch:automatic,experimentalFeatures:true}})},automatic);
        await controls.getByRole('spinbutton',{name:'Searches per batch',exact:true}).waitFor({state:automatic?'hidden':'visible'});
        try { await finish.waitForFunction(()=>{const body=document.querySelector('[data-panel-id="controls"] .dash-panel-body');return body&&body.scrollHeight<=body.clientHeight+1},undefined,{timeout:3000}) }
        catch (error) {
          console.error('Controls overflow', {viewportWidth:width,automatic,...await controls.locator('.dash-panel-body').evaluate(e=>({height:e.clientHeight,scroll:e.scrollHeight,bodyWidth:e.clientWidth}))});
          await finish.screenshot({path:path.join(output,'controls-overflow.png')});throw error;
        }
      }
    }
    const balance=finish.locator('[data-panel-id="balance"]');
    const balanceOriginal=await worker.evaluate(async()=>({stats:(await chrome.storage.local.get('lastStats')).lastStats,coupons:(await chrome.storage.local.get('lastCoupons')).lastCoupons,animations:(await chrome.storage.sync.get('settings')).settings.animationsEnabled}));
    await worker.evaluate(async()=>{
      const {lastStats}=await chrome.storage.local.get('lastStats');
      const {settings}=await chrome.storage.sync.get('settings');
      await chrome.storage.sync.set({settings:{...settings,animationsEnabled:false}});
      await chrome.storage.local.set({lastStats:{...lastStats,at:Date.now(),availablePoints:'12,345,678',readyToClaim:'1,234',dailyStreak:'123 days',stampBonus:'3/12',membership:'Gold Member'},lastCoupons:{at:Date.now(),available:12}});
    });
    await expect(balance.locator('.dash-hero-value')).toHaveText('12,345,678');
    const balanceSizes=['3x2','4x2','4x3','6x2','6x3'];
    for(const width of [380,768,1100,1440]){
      await finish.setViewportSize({width,height:780});
      for(const dimensions of balanceSizes){
        await finish.getByRole('button',{name:'Edit layout',exact:true}).click();
        await balance.getByRole('combobox',{name:'Size of Balance',exact:true}).selectOption(dimensions);
        await waitLayout(state=>state.dashLayout?.items.some(item=>item.i==='balance'&&`${item.w}x${item.h}`===dimensions),'Balance size not saved');
        await finish.getByRole('button',{name:'Done',exact:true}).click();
        await expect.poll(()=>balance.evaluate(panel=>{
          const body=panel.querySelector('.dash-panel-body'),bounds=body.getBoundingClientRect();
          const metrics=[...panel.querySelectorAll('.dash-tiles > .dash-tile')];
          const text=[...panel.querySelectorAll('.dash-hero-value,.dash-medal,.dash-status,.dash-tile-label,.dash-tile-value,.dash-tile-sub')];
          return body.scrollHeight<=body.clientHeight+1&&body.scrollWidth<=body.clientWidth+1&&metrics.length===4&&metrics.every(metric=>{const rect=metric.getBoundingClientRect();return rect.top>=bounds.top-1&&rect.bottom<=bounds.bottom+1&&rect.right<=bounds.right+1})&&text.every(element=>element.scrollWidth<=element.clientWidth+1);
        }),{message:`Balance ${dimensions} fits all four metrics and text at ${width}px`}).toBe(true);
        if(width===1100&&dimensions==='3x2')await balance.screenshot({path:path.join(output,'dashboard-balance-compact.png')});
      }
    }
    await balance.locator('.dash-tile--press').click();
    await balance.locator('.star-detail').waitFor();
    assert.equal(await balance.locator('.star-detail .star').count(),12,'Stamp details stay available');
    await balance.locator('.dash-tile--press').click();
    await balance.locator('.star-detail').waitFor({state:'hidden'});
    await worker.evaluate(async original=>{
      const {settings}=await chrome.storage.sync.get('settings');
      await chrome.storage.sync.set({settings:{...settings,animationsEnabled:original.animations}});
      await chrome.storage.local.set({lastStats:original.stats});
      if(original.coupons)await chrome.storage.local.set({lastCoupons:original.coupons});else await chrome.storage.local.remove('lastCoupons');
    },balanceOriginal);
    await expect(balance.locator('.dash-hero-value')).toHaveText('250');
    await finish.getByRole('button',{name:'Edit layout',exact:true}).click();
    await finish.getByRole('button',{name:'Default layout',exact:true}).click();
    await finish.getByRole('button',{name:'Done',exact:true}).click();
    await finish.setViewportSize({width:1100,height:780});
    await finish.waitForFunction(()=>Array.from(document.querySelectorAll('.react-grid-item')).every(item=>item.getBoundingClientRect().right<=window.innerWidth+1));
    await expect.poll(()=>finish.locator('[data-panel-id="balance"],[data-panel-id="history"],[data-panel-id="streaks"]').evaluateAll(panels=>{
      const tops=panels.map(panel=>panel.getBoundingClientRect().top);return Math.max(...tops)-Math.min(...tops);
    })).toBeLessThanOrEqual(1);
    await finish.screenshot({path:path.join(output,'dashboard-controls.png')});
    await finish.getByRole('button',{name:'Settings',exact:true}).click();
    await expect(finish.getByRole('switch',{name:'Top bar background',exact:true})).toHaveAttribute('aria-checked','false');
    await expect(finish.getByRole('switch',{name:'Bottom bar background',exact:true})).toHaveAttribute('aria-checked','true');
    await setSwitch(finish,'Bottom bar background','bottomBarBackground',false);
    await checkBarrier('bottom',false,'Dashboard clears popup bottom backing');
    await setSwitch(finish,'Top bar background','topBarBackground',true);
    await checkBarrier('top',true,'Dashboard shows popup top backing');
    await checkBlur(popup.locator('.topbar'),8,'Dashboard setting preserves floating header glass');
    await checkBlur(popup.locator('.tabbar .tab:not(.active)'),8,'Dashboard setting preserves floating navigation glass');
    await setSwitch(finish,'Top bar background','topBarBackground',false);
    await setSwitch(finish,'Low power mode','lowPowerMode',true);
    await checkBarrier('top',false,'Low power preserves cleared top backing');
    await checkBarrier('bottom',false,'Low power preserves cleared bottom backing');
    await checkBlur(popup.locator('.topbar'),0,'Low-power floating header');
    await checkBlur(popup.locator('.tabbar .tab:not(.active)'),0,'Low-power floating navigation buttons');
    await setSwitch(finish,'Top bar background','topBarBackground',true);
    await setSwitch(finish,'Bottom bar background','bottomBarBackground',true);
    await checkBarrier('top',true,'Low-power opaque top backing');
    await checkBarrier('bottom',true,'Low-power opaque bottom backing');
    const opaqueSurface=await popup.locator('[data-widget-id="balance"] .card').evaluate(element=>getComputedStyle(element).backgroundColor);
    assert.notEqual(opaqueSurface,'rgba(0, 0, 0, 0)');
    await expect(popup.locator('.topbar')).toHaveCSS('background-color',opaqueSurface);
    await expect(popup.locator('.tabbar .tab:not(.active)').first()).toHaveCSS('background-color',opaqueSurface);
    await expect(popup.locator('.tabbar')).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
    await setSwitch(finish,'Bottom bar background','bottomBarBackground',false);
    await checkBarrier('bottom',false,'Low-power bottom backing clears independently');
    await checkBarrier('top',true,'Low-power top backing remains shown');
    await finish.getByRole('button',{name:'Settings',exact:true}).click();
    await finish.locator('.cursor-glow--rest').waitFor();
    await checkBlur(finish.locator('.dash-panel'),0,'Low-power dashboard widget');
    await checkBlur(finish.locator('.dash-edit-bar'),0,'Low-power dashboard controls');
    await checkBlur(popup.locator('.topbar'),0,'Low-power popup header');
    await worker.evaluate(async()=>{const{settings}=await chrome.storage.sync.get('settings');await chrome.storage.sync.set({settings:{...settings,lowPowerMode:false,theme:'nord'}})});
    await finish.locator('.cursor-dot').waitFor();
    assert.equal(await finish.locator('html').getAttribute('data-theme'),'nord');
    await finish.emulateMedia({reducedMotion:'reduce'});
    await finish.locator('.cursor-glow--rest').waitFor();
    await finish.emulateMedia({reducedMotion:'no-preference'});
    await finish.locator('.cursor-dot').waitFor();
    await finish.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'))});
    await finish.locator('.cursor-glow--rest').waitFor();
    const failure=await context.newPage();
    await failure.addInitScript(()=>{const read=chrome.storage.sync.get.bind(chrome.storage.sync);chrome.storage.sync.get=(...args)=>window.__retryStorage ? read(...args):Promise.reject(new Error('Fixture storage outage'))});
    await failure.goto(`chrome-extension://${id}/index.html`);
    await failure.getByRole('heading',{name:'Settings unavailable'}).waitFor();
    await failure.screenshot({path:path.join(output,'storage-error.png')});
    await failure.evaluate(()=>{window.__retryStorage=true});
    await failure.getByRole('button',{name:'Try again'}).click();
    await failure.locator('.brand-glyph').waitFor();
    assert.equal(await worker.evaluate(async()=>(await chrome.storage.sync.get('settings')).settings.redeemGoalPts),9999);
    await worker.evaluate(()=>chrome.storage.local.set({runState:{v:1,stopEpoch:0,activity:{label:'Fixture busy'},batch:null,routine:null,rightSizeRun:null,captures:{capturing:[],opened:{}}}}));
    await failure.getByRole('navigation').getByRole('button',{name:'Run',exact:true}).click();
    await failure.getByRole('button',{name:'Run the routine',exact:true}).click();
    await failure.locator('.action-feedback').filter({hasText:'current activity'}).waitFor();
    await failure.getByRole('button',{name:'Dismiss action message'}).click();
    assert.equal(await failure.locator('.action-feedback').count(),0);
    await finish.getByRole('button',{name:'Run the routine',exact:true}).click();
    await finish.locator('.action-feedback').filter({hasText:'current activity'}).waitFor();
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,browser:browserName(),version:JSON.parse(fs.readFileSync(path.join(build,'manifest.json'),'utf8')).version,popupWidgetsAddRemoveResize:true,dashboardWidgetsAddRemoveResize:true,emptyLayoutAndReset:true,toolbarWidgetEditing:true,sevenSegmentEvidence:true,completedSegmentsOmitChecks:true,sharedHistory:true,glassBlurRealSlider:true,independentFullWidthBarriers:true,renderedContentUnderBothBars:true,floatingGlassPreserved:true,compactTransparentDock:true,hiddenScrollbarsRetainScrolling:true,compactDismissibleNotices:true,dismissalsSurviveReopen:true,newNewsAndUpdateReappear:true,previewIsolated:true,rewardsLinksOnAllThreeSurfaces:true,narrowFinishActions:true,backupRoundtrip:true,ordersExcludedByDefault:true,mergePreservesCurrent:true,recoveryBackup:true,oneFinishBackground:true,finishFocusTrap:true,liveLowPower:true,liveTheme:true,reducedMotion:true,hiddenMotionPaused:true,storageErrorRetry:true,commandErrorsVisible:true,output}));
  } finally {
    if(context)await context.close();
    if(!path.resolve(profile).startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(profile).startsWith('gingerbread-ui-check-'))throw Error('Unsafe cleanup path');
    fs.rmSync(profile,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1});
