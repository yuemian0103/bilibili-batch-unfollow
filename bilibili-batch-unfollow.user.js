// ==UserScript==
// @name         B站批量取关（v2.2.5 最终修复版）
// @version      2.2.5
// @description  修复投稿页面验证无Cookie导致的视频误判；新增投稿页面扫描+视频三重验证+无动态精准判定；修复视频漏检+已完成数异常+断点续扫失效；日志同步UI+控制台；新增已完成/剩余UP数、接口阻塞自动暂停5分钟；新增“不活跃+有视频”取关按钮
// @match        https://www.bilibili.com/*
// @match        https://space.bilibili.com/*
// @match        https://space.bilibili.com/*/upload/video
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      api.bilibili.com
// @namespace    https://greasyfork.org/users/1532336
// ==/UserScript==

(function(){
"use strict";

/***********************
 * 配置参数
 ***********************/
const INACTIVE_DAYS = 365;          // 判定不活跃的天数（一年）
const CONCURRENCY = 8;              // 扫描并发数（建议≤10）
const PAGE_SIZE = 50;               // 拉取关注列表每页数量
const SCAN_MIN_MS = 400;            // 扫描间隔最小值(ms)
const SCAN_MAX_MS = 1200;           // 扫描间隔最大值(ms)
const UNFOLLOW_MIN_MS = 1800;       // 单条取关间隔最小值(ms)
const UNFOLLOW_MAX_MS = 4200;       // 单条取关间隔最大值(ms)
const NO_DYNAMIC_THRESHOLD = 20;    // 连续无动态阈值
const AUTO_RECHECK = true;          // 自动复核开关

const UNFOLLOW_BATCH_SIZE = 5;      // 每批取关数量
const UNFOLLOW_BATCH_DELAY_MIN = 60000;  // 批次间隔最小值(ms)
const UNFOLLOW_BATCH_DELAY_MAX = 120000; // 批次间隔最大值(ms)

const MAX_TASK_RETRIES = 3;         // 任务最大重试次数
const UNFOLLOW_MAX_ATTEMPTS = 3;    // 取关最大尝试次数
const WAF_PAUSE_MSG = "WAF_DETECTED"; // 风控暂停标识
const BLOCKED_PAUSE_DURATION = 5 * 60 * 1000; // 接口阻塞自动暂停5分钟

/***********************
 * 本地存储
 ***********************/
const store = {
    save(k,v){ localStorage.setItem("bili_unf_"+k,JSON.stringify(v)); },
    load(k,d){ try{ return JSON.parse(localStorage.getItem("bili_unf_"+k))||d }catch{ return d; }},
    remove(k){ localStorage.removeItem("bili_unf_"+k); }
};

/***********************
 * 全局状态
 ***********************/
let gAllFollowings = store.load("allFollowings",[]);
let gScannedUids = new Set(store.load("scannedUids",[]));
let gTaskQueue = store.load("taskQueue",[]);
let gInactiveMap = new Map(store.load("inactiveList",[]));
let gNoDynFirst = store.load("nodynFirst",[]);
let gNoDynFinal = store.load("nodynFinal",[]);
let gPausedFlag = store.load("paused",false);
let gConsecutiveNoDyn = store.load("streak",0);
let gIsScanning = false;
let gIsRechecking = false;
let gBlockedList = store.load("blockedList",[]);
let gIsAutoPausing = false;

/***********************
 * UI样式与面板（关键修改：新增⑤按钮）
 ***********************/
GM_addStyle(`
#bili-panel{position:fixed;top:80px;right:20px;z-index:999999;background:#fff;border:1px solid #ddd;width:360px;border-radius:10px;padding:12px;box-shadow:0 4px 16px rgba(0,0,0,.12);font-size:12px;}
#bili-panel button{width:100%;padding:6px 0;margin-top:6px;border-radius:6px;border:1px solid #ccc;background:#f7f7f7;cursor:pointer;}
#bili-panel button:disabled{opacity:0.5;cursor:not-allowed;}
#bili-log{margin-top:8px;height:230px;overflow-y:auto;font-family:monospace;white-space:pre-wrap;background:#fafafa;padding:8px;border-radius:6px;border:1px solid #eee;}
#bili-panel .small{font-size:11px;color:#666;margin-top:6px;}
#bili-panel .flex{display:flex;gap:6px;}
#bili-panel .flex button{flex:1;}
`);
const panel = document.createElement("div");
panel.id = "bili-panel";
panel.innerHTML=`
<div><b>B站批量取关（v2.2.5 最终修复版）</b></div>
<div id="bili-status">状态：空闲</div>
<div id="bili-stats" class="small"></div>
<div class="flex">
  <button id="bili-btn-scan">① 扫描（断点续扫）</button>
  <button id="bili-btn-pause" title="手动暂停/恢复">暂停</button>
</div>
<button id="bili-btn-recheck" disabled>② 复核“无动态”</button>
<button id="bili-btn-unfollow-nodyn" disabled>③ 慢速取关（无动态）</button>
<button id="bili-btn-unfollow-inactive" disabled>④ 慢速取关（一年无动态+无视频）</button>
<!-- 新增：⑤慢速取关（不活跃+有视频）按钮 -->
<button id="bili-btn-unfollow-inactive-with-video" disabled>⑤ 慢速取关（不活跃+有视频）</button>
<button id="bili-btn-export" disabled>导出结果（TXT）</button>
<button id="bili-btn-retry-blocked" disabled>重新扫描屏蔽/失败UP</button>
<button id="bili-btn-reset" style="margin-top:8px;color:red;">重置缓存（清零）</button>
<div id="bili-log"></div>
`;
document.body.appendChild(panel);

// UI元素获取（关键修改：新增⑤按钮的元素获取）
const statusEl=document.getElementById("bili-status");
const statsEl=document.getElementById("bili-stats");
const logBox=document.getElementById("bili-log");
const btnScan=document.getElementById("bili-btn-scan");
const btnPause=document.getElementById("bili-btn-pause");
const btnRecheck=document.getElementById("bili-btn-recheck");
const btnUnfollowNoDyn=document.getElementById("bili-btn-unfollow-nodyn");
const btnUnfollowInactive=document.getElementById("bili-btn-unfollow-inactive");
// 新增：⑤按钮的DOM元素
const btnUnfollowInactiveWithVideo = document.getElementById("bili-btn-unfollow-inactive-with-video");
const btnExport=document.getElementById("bili-btn-export");
const btnRetryBlocked=document.getElementById("bili-btn-retry-blocked");
const btnReset=document.getElementById("bili-btn-reset");

/***********************
 * 工具函数
 ***********************/
function log(msg){
    const now = new Date();
    const time = now.toLocaleTimeString();
    const fullLog = `[${time}] ${msg}`;

    logBox.textContent += `${fullLog}\n`;
    logBox.scrollTop=logBox.scrollHeight;
    console.log(fullLog);
}

function setStatus(s){ statusEl.textContent="状态："+s; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function randInt(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
function randSleep(a,b){ return sleep(randInt(a,b)); }

function persistState(){
    store.save("allFollowings",gAllFollowings);
    store.save("taskQueue",gTaskQueue);
    store.save("scannedUids",Array.from(gScannedUids));
    store.save("inactiveList",Array.from(gInactiveMap.entries()));
    store.save("nodynFirst",gNoDynFirst);
    store.save("nodynFinal",gNoDynFinal);
    store.save("paused",gPausedFlag);
    store.save("streak",gConsecutiveNoDyn);
    store.save("blockedList",gBlockedList);
    updateStats();
}

function updateStats(){
    const completedCount = gScannedUids.size;
    const remainingCount = gTaskQueue.length;
    const totalCount = gAllFollowings.length;
    statsEl.innerHTML=`✅ 已完成 UP 数：${completedCount}<br>✅ 剩余 UP 数：${remainingCount}<br>关注总数：${totalCount}<br>不活跃：${gInactiveMap.size}<br>首轮无动态：${gNoDynFirst.length}<br>复核无动态：${gNoDynFinal.length}<br>连续无动态：${gConsecutiveNoDyn}/${NO_DYNAMIC_THRESHOLD}`;
}

/***********************
 * B站接口基础函数
 ***********************/
function httpGet(url){
    return new Promise((resolve,reject)=>{
        GM_xmlhttpRequest({
            method:"GET",
            url,
            credentials: "include", // 全局添加：携带Cookie
            onload:res=>{
                try{ resolve(JSON.parse(res.responseText)); }
                catch{ reject(new Error("NON_JSON")); }
            },
            onerror:err=>reject(err)
        });
    });
}

async function getSelf(){
    const j = await httpGet("https://api.bilibili.com/x/web-interface/nav");
    if(j.code!==0) throw new Error("未登录");
    return j.data;
}

async function getAllFollowings(mid){
    const list=[], seen=new Set();
    let pn=1;
    while(true){
        const url=`https://api.bilibili.com/x/relation/followings?vmid=${mid}&pn=${pn}&ps=${PAGE_SIZE}`;
        const j = await httpGet(url);
        if(j.code!==0) break;
        const arr=j.data.list||[];
        if(arr.length===0) break;
        for(const it of arr){
            if(!seen.has(it.mid)){
                seen.add(it.mid);
                list.push({mid:it.mid,uname:it.uname});
            }
        }
        if(arr.length<PAGE_SIZE) break;
        pn++;
        await randSleep(300,800);
    }
    return list;
}

/***********************
 * 核心：视频验证（三重验证+Cookie修复）
 ***********************/
// 1. 投稿页面DOM验证（核心修复：携带登录Cookie）
async function checkUploadPageHasVideo(mid) {
    try {
        const uploadUrl = `https://space.bilibili.com/${mid}/upload/video`;
        const html = await new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: uploadUrl,
                credentials: "include", // 关键修复：携带登录Cookie
                onload: res => resolve(res.responseText),
                onerror: err => reject(err)
            });
        });
        // 增强检测：兼容B站不同版本的视频列表class
        const hasVideoElement = /class="video-list-item|class="bili-video-card"/.test(html);
        // 增强检测：更多“无投稿”提示文案
        const hasNoVideoTip = /暂无投稿|还没有发布任何视频|没有投稿内容|暂无作品/.test(html);
        if (hasVideoElement && !hasNoVideoTip) {
            log(`[投稿页面验证] ${mid} → 存在视频`);
            return true;
        } else {
            log(`[投稿页面验证] ${mid} → 无视频`);
            return false;
        }
    } catch (e) {
        log(`[投稿页面验证失败] ${mid} → ${e.message}，降级为API验证`);
        return false;
    }
}

// 2. 视频API多页验证（主验证）
async function hasPublishedVideos(mid) {
    try {
        const now = Math.floor(Date.now() / 1000);
        const oneYearAgo = now - INACTIVE_DAYS * 24 * 3600;
        let hasVideo = false;
        let pn = 1;

        // 多页查询视频API（避免1页漏检）
        while (true) {
            const url = `https://api.bilibili.com/x/space/arc/search?mid=${mid}&pn=${pn}&ps=30&order=pubdate&jsonp=jsonp`;
            const j = await httpGet(url);
            if (j.code !== 0) break;

            const videos = j.data?.list?.vlist || [];
            if (videos.length === 0) break;

            // 检查近1年视频
            for (const video of videos) {
                if (video.created >= oneYearAgo) {
                    log(`[视频API验证] ${video.author} (${mid}) → 近1年有视频：${video.title}（发布时间：${new Date(video.created*1000).toISOString().slice(0,10)}）`);
                    hasVideo = true;
                    break;
                }
            }
            if (hasVideo || videos.length < 30) break; // 有视频/无更多页则停止
            pn++;
            await randSleep(300, 700);
        }

        // API无视频时，补充投稿页面验证
        if (!hasVideo) {
            const uploadPageHasVideo = await checkUploadPageHasVideo(mid);
            hasVideo = uploadPageHasVideo;
        }

        return hasVideo;
    } catch (e) {
        log(`[视频验证异常] ${mid} → ${e.message}，补充投稿页面验证`);
        return await checkUploadPageHasVideo(mid);
    }
}

// 3. 动态列表视频验证（补漏）
async function hasVideoInDynamics(mid){
    try{
        let pn = 1;
        while(true){
            const url = `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${mid}&pn=${pn}`;
            const j = await httpGet(url);
            if(j.code!==0) break;
            const items = j.data?.items||[];
            if(items.length===0) break;
            for(const it of items){
                const modules = it.modules || {};
                const moduleC = modules.module_dynamic?.major?.archive || modules.module_dynamic?.major?.video;
                if(moduleC) return true;
            }
            if(items.length<20) break;
            pn++;
            await randSleep(300,700);
        }
        return false;
    }catch(e){
        log(`动态列表检测视频失败：${mid} → ${e.message}`);
        return false;
    }
}

// 三重视频验证整合
async function checkHasVideo(mid){
    // 步骤1：视频API多页验证（主）
    const hasPubVideo = await hasPublishedVideos(mid);
    if(hasPubVideo) return true;

    // 步骤2：动态列表验证（补漏）
    const hasDynamicVideo = await hasVideoInDynamics(mid);
    return hasDynamicVideo;
}

/***********************
 * 动态检测
 ***********************/
async function getLastDynamicTs(uid){
    try{
        const url=`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${uid}`;
        const j=await httpGet(url);
        if(j.code!==0 && [-352,-412,-403,-401].includes(j.code)) throw new Error("BLOCKED");
        const items=j?.data?.items||[];
        let latest=0;
        for(const it of items){
            const ts=it?.modules?.module_author?.pub_ts;
            if(ts>latest) latest=ts;
        }
        return latest||null;
    }catch(e){
        if(e.message==="BLOCKED"||e.message==="NON_JSON") throw e;
        return null;
    }
}

/***********************
 * CSRF Token获取
 ***********************/
function getCsrf() {
    try{ if (typeof unsafeWindow !== "undefined" && unsafeWindow.__BiliUser__ && unsafeWindow.__BiliUser__.csrf) return unsafeWindow.__BiliUser__.csrf; }catch{}
    try{ if (typeof unsafeWindow !== "undefined" && unsafeWindow.__INITIAL_STATE__?.login?.csrf) return unsafeWindow.__INITIAL_STATE__.login.csrf; }catch{}
    try{ if (window.__BILI_USER__?.csrf) return window.__BILI_USER__.csrf; }catch{}
    try{ if (window.__INITIAL_STATE__?.login?.csrf) return window.__INITIAL_STATE__.login.csrf; }catch{}
    try{ const m = document.cookie.match(/bili_jct=([^;]+)/); if(m && m[1]) return m[1]; }catch{}
    return "";
}

/***********************
 * 取关接口
 ***********************/
async function doUnfollowAPI(mid){
    const csrf = getCsrf();
    if(!csrf) throw new Error("NO_CSRF");
    const bodyStr = `fid=${encodeURIComponent(mid)}&act=2&re_src=11&csrf=${encodeURIComponent(csrf)}`;
    const res = await fetch("https://api.bilibili.com/x/relation/modify",{
        method:"POST",
        headers:{
            "Content-Type":"application/x-www-form-urlencoded; charset=UTF-8",
            "Referer":"https://www.bilibili.com/",
            "X-Requested-With":"XMLHttpRequest"
        },
        body: bodyStr,
        credentials:"include"
    }).then(r=>r.json()).catch(()=>{throw new Error("NETWORK_ERR");});
    if(!res || typeof res.code==="undefined") throw new Error("NON_JSON_RESP");
    if(res.code===412 || res.code===-403 || res.code===403) throw new Error(WAF_PAUSE_MSG+":"+res.code);
    if(res.code!==0) throw new Error("UNFOLLOW_FAIL:"+res.message+":"+res.code);
    return res;
}

/***********************
 * 接口阻塞自动暂停
 ***********************/
async function autoPauseAndResume() {
    if (gIsAutoPausing) return;
    gIsAutoPausing = true;
    gPausedFlag = true;
    const pauseMinutes = BLOCKED_PAUSE_DURATION / 60000;
    const pauseStart = new Date().toLocaleTimeString();
    log(`🚨 检测到接口阻塞，全局自动暂停 ${pauseMinutes} 分钟（暂停开始：${pauseStart}）`);
    setStatus(`自动暂停 - ${pauseMinutes}分钟后恢复`);
    persistState();

    await sleep(BLOCKED_PAUSE_DURATION);

    gPausedFlag = false;
    const resumeTime = new Date().toLocaleTimeString();
    log(`✅ 自动暂停结束（恢复时间：${resumeTime}），继续扫描`);
    setStatus("扫描中...");
    persistState();
    gIsAutoPausing = false;
}

/***********************
 * 扫描Worker
 ***********************/
async function scanWorker(workerId){
    while(true){
        if(gPausedFlag){
            log(`[线程${workerId}] 检测到全局暂停，扫描线程挂起`);
            while(gPausedFlag) {
                await sleep(1000);
            }
            log(`[线程${workerId}] 恢复扫描`);
        }
        if(gTaskQueue.length===0) return;
        const task = gTaskQueue.shift();
        if(!task || gScannedUids.has(task.mid)) continue;

        task._retries = task._retries||0;
        const {mid,uname} = task;

        try{
            const ts = await getLastDynamicTs(mid);
            const now = Math.floor(Date.now()/1000);
            const deadline = now - INACTIVE_DAYS*24*3600;

            gScannedUids.add(mid);

            if(ts !== null){
                if(ts < deadline){
                    // 三重视频验证
                    const hasVideo = await checkHasVideo(mid);
                    gInactiveMap.set(mid,{mid,uname,ts,hasVideo});
                    if(hasVideo) log(`[不活跃超过一年+有视频] ${uname} (${new Date(ts*1000).toISOString().slice(0,10)})`);
                    else log(`[不活跃超过一年+无视频] ${uname} (${new Date(ts*1000).toISOString().slice(0,10)})`);
                } else {
                    log(`[活跃] ${uname} (${new Date(ts*1000).toISOString().slice(0,10)})`);
                }
            } else {
                // 无动态时验证视频
                const hasVideo = await checkHasVideo(mid);
                if(!gNoDynFirst.some(x=>x.mid===mid)) gNoDynFirst.push({mid,uname,hasVideo});
                log(`[无动态] ${uname} → 视频检测：${hasVideo?"有":"无"} → 暂停 30s`);
                await sleep(30000);
            }

            persistState();
            await randSleep(SCAN_MIN_MS,SCAN_MAX_MS);
        }catch(e){
            task._retries++;
            if(e.message==="BLOCKED" || e.message==="NON_JSON"){
                log(`🧩 接口阻塞：${uname} → 重试 ${task._retries}/${MAX_TASK_RETRIES}`);
                if (task._retries === 1) {
                    await autoPauseAndResume();
                }
                if(task._retries <= MAX_TASK_RETRIES){
                    await sleep(30000);
                    gTaskQueue.push(task);
                } else {
                    log(`⚠️ 超过最大重试次数，将 ${uname} 标为疑似屏蔽/隐私`);
                    gBlockedList.push({mid,uname});
                    gScannedUids.add(mid);
                }
            } else {
                if(task._retries <= MAX_TASK_RETRIES){
                    log(`[请求异常] ${uname} → 放回队列稍后再尝试 (${task._retries})`);
                    gTaskQueue.push(task);
                } else {
                    log(`[请求异常且重试超限] ${uname} → 移入 blockedList`);
                    gBlockedList.push({mid,uname});
                    gScannedUids.add(mid);
                }
                await sleep(5000);
            }
            persistState();
            await randSleep(SCAN_MIN_MS,SCAN_MAX_MS);
        }
    }
}

/***********************
 * 分批取关逻辑
 ***********************/
async function doUnfollowList(list){
    if(list.length===0){ alert("没有可取关对象"); return; }
    if(gPausedFlag){ alert("当前处于暂停状态，请先恢复后再执行取关"); return; }
    if(!confirm(`确认取关 ${list.length} 个UP主？\n此操作不可撤销！`)) return;

    setStatus("分批取关中...");
    log(`开始分批取关，共 ${list.length} 个，每批 ${UNFOLLOW_BATCH_SIZE} 个`);
    disableAllButtons(true);

    try{
        for(let i=0;i<list.length;i+=UNFOLLOW_BATCH_SIZE){
            const batch = list.slice(i,i+UNFOLLOW_BATCH_SIZE);
            log(`⚡ 批次 ${Math.floor(i/UNFOLLOW_BATCH_SIZE)+1}，共 ${batch.length} 个`);
            for(const {mid,uname} of batch){
                let success=false,reason="";
                for(let attempt=1;attempt<=UNFOLLOW_MAX_ATTEMPTS;attempt++){
                    try{
                        await doUnfollowAPI(mid);
                        log(`🗑 已取关：${uname} (${mid})`);
                        success=true; break;
                    }catch(e){
                        reason=e.message||"UNKNOWN_ERROR";
                        if(reason.indexOf(WAF_PAUSE_MSG)===0){
                            log(`🚨 风控触发，进入全局暂停`);
                            gPausedFlag=true;
                            persistState();
                            setStatus("风控暂停 - 手动恢复");
                            throw new Error("PAUSED_BY_WAF");
                        }
                        log(`[尝试${attempt}] ❌ 取关失败：${uname} (${mid}) → 原因：${reason}`);
                        await sleep(randInt(3000,8000));
                    }
                }
                if(!success) log(`⚠️ 最终取关失败：${uname} (${mid}) → 原因：${reason}`);
                await randSleep(UNFOLLOW_MIN_MS,UNFOLLOW_MAX_MS);
            }
            const batchDelay = randInt(UNFOLLOW_BATCH_DELAY_MIN,UNFOLLOW_BATCH_DELAY_MAX);
            log(`🛌 批次完成，休息 ${(batchDelay/1000).toFixed(1)} 秒...`);
            await sleep(batchDelay);
            if(gPausedFlag){ log("已进入暂停，结束分批取关流程"); break; }
        }
    }catch(e){ log("分批取关中断："+e.message); }
    finally{
        setStatus("空闲");
        disableAllButtons(false);
        persistState();
    }
}

/***********************
 * UI事件绑定（关键修改：新增⑤按钮的点击事件）
 ***********************/
btnPause.addEventListener("click",()=>{
    gPausedFlag=!gPausedFlag;
    btnPause.textContent=gPausedFlag?"恢复":"暂停";
    setStatus(gPausedFlag?"已暂停":"空闲");
    persistState();
});

btnReset.addEventListener("click",()=>{
    if(confirm("确认重置所有缓存和扫描状态？")) {
        localStorage.clear();
        gAllFollowings = [];
        gScannedUids = new Set();
        gTaskQueue = [];
        gInactiveMap = new Map();
        gNoDynFirst = [];
        gNoDynFinal = [];
        gPausedFlag = false;
        gConsecutiveNoDyn = 0;
        gBlockedList = [];
        persistState();
        updateStats();
        log("已重置所有缓存，页面即将刷新");
        location.reload();
    }
});

// 导出按钮事件（已含空间地址）
btnExport.addEventListener("click",()=>{
    const lines=[];
    // 处理不活跃列表
    for(const [mid,obj] of gInactiveMap){
        const statusText = obj.hasVideo?"不活跃+有视频":"不活跃+无视频";
        const spaceText = `       ${obj.uname}的个人空间：https://space.bilibili.com/${mid}`;
        lines.push(`${mid}——${obj.uname}——${statusText}${spaceText}`);
    }
    // 处理无动态列表
    for(const obj of gNoDynFinal){
        const statusText = obj.hasVideo?"无动态+有视频":"无动态+无视频";
        const spaceText = `       ${obj.uname}的个人空间：https://space.bilibili.com/${obj.mid}`;
        lines.push(`${obj.mid}——${obj.uname}——${statusText}${spaceText}`);
    }
    const blob=new Blob([lines.join("\n")],{type:"text/plain;charset=utf-8"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;
    a.download="bili_unfollow_list.txt";
    a.click();
    URL.revokeObjectURL(url);
});

btnScan.addEventListener("click",async()=>{
    if(gIsScanning){ alert("扫描中，请勿重复点击"); return; }
    setStatus("扫描中...");
    disableAllButtons(true);
    gIsScanning=true;

    try{
        const self = await getSelf();

        if(gAllFollowings.length===0){
            log("首次扫描，正在拉取关注列表...");
            gAllFollowings = await getAllFollowings(self.mid);
            log(`拉取完成，共 ${gAllFollowings.length} 个关注UP`);
        }

        if(gTaskQueue.length===0){
            gTaskQueue = gAllFollowings.filter(item => !gScannedUids.has(item.mid));
            log(`断点续扫：已扫描 ${gScannedUids.size} 个，待扫描 ${gTaskQueue.length} 个`);
        }

        await Promise.all(Array.from({length:CONCURRENCY},(_,i)=>scanWorker(i)));

        setStatus("扫描完成");
        log(`扫描完成！总计扫描 ${gScannedUids.size} 个，关注总数 ${gAllFollowings.length} 个`);
        persistState();

        // 扫描完成后启用所有功能按钮（含新增的⑤按钮）
        btnRecheck.disabled=false;
        btnUnfollowNoDyn.disabled=false;
        btnUnfollowInactive.disabled=false;
        btnUnfollowInactiveWithVideo.disabled=false; // 新增：启用⑤按钮
        btnExport.disabled=false;
        btnRetryBlocked.disabled=false;
    }catch(e){
        log("扫描失败："+e.message);
    }
    finally{
        gIsScanning=false;
        disableAllButtons(false);
    }
});

// 复核逻辑（三重视频验证）
btnRecheck.addEventListener("click",async()=>{
    if(gIsRechecking){ alert("复核中，请勿重复点击"); return; }
    setStatus("复核无动态列表...");
    disableAllButtons(true);
    gIsRechecking=true;
    gNoDynFinal=[];
    for(const obj of gNoDynFirst){
        const hasVideo = await checkHasVideo(obj.mid);
        gNoDynFinal.push({mid:obj.mid,uname:obj.uname,hasVideo});
        log(`[复核] ${obj.uname} → 视频检测：${hasVideo?"有":"无"}`);
        await randSleep(500,1200);
    }
    gIsRechecking=false;
    setStatus("复核完成");
    disableAllButtons(false);
    persistState();
});

// 取关绑定（含新增的⑤按钮逻辑）
btnUnfollowNoDyn.addEventListener("click",()=>doUnfollowList(gNoDynFinal.filter(x=>!x.hasVideo)));
btnUnfollowInactive.addEventListener("click",()=>{
    const list=[];
    for(const [mid,obj] of gInactiveMap){ if(!obj.hasVideo) list.push(obj); }
    doUnfollowList(list);
});
// 新增：⑤按钮的点击事件（取关“不活跃+有视频”的UP）
btnUnfollowInactiveWithVideo.addEventListener("click", () => {
    const list = [];
    // 筛选gInactiveMap中hasVideo为true的UP
    for(const [mid, obj] of gInactiveMap) {
        if(obj.hasVideo) list.push(obj);
    }
    doUnfollowList(list);
});

// 重新扫描屏蔽UP
btnRetryBlocked.addEventListener("click",()=>{
    if(gBlockedList.length===0){ alert("没有失败或屏蔽UP"); return; }
    gTaskQueue.push(...gBlockedList);
    gBlockedList.forEach(item => gScannedUids.delete(item.mid));
    gBlockedList = [];
    persistState();
    btnScan.click();
});

/***********************
 * 辅助函数（关键修改：将⑤按钮加入禁用列表）
 ***********************/
function disableAllButtons(flag){
    // 数组中新增⑤按钮
    [btnScan, btnRecheck, btnUnfollowNoDyn, btnUnfollowInactive, btnUnfollowInactiveWithVideo, btnExport, btnRetryBlocked].forEach(b=>b.disabled=flag);
    btnPause.disabled=false;
}

// 初始化
updateStats();
setStatus("空闲");
log("脚本加载完成（v2.2.5 最终修复版）：修复投稿页面Cookie验证+增强视频检测规则+导出添加空间地址+新增“不活跃+有视频”取关按钮");
})();