/**
 * background.js
 * 
 * 自动备份时机：安装或更新插件、使用某个用户资料启动 Chrome 浏览器
 * 
 * 注意：
 *   移除插件会清空 Chrome Extension Storage 中的备份数据
 *   如何手动删除备份数据: 浏览器开发者工具 - Application - Storage - Extension Storage - 插件名 - Local
 */


/**
 * 定义常量:
 * 1.chrome.storage.local中使用的键名
 * 2.B站API地址
 * 3.监听请求用的模式匹配地址
 */
const STORAGE_BACKUP_KEY = "all_medias";   // 所有收藏夹的视频信息备份
const STORAGE_MID_KEY = "mid";             // 用户ID
const STORAGE_FAVLIST_KEY = "favlist";     // 用户收藏夹列表
const API_LIST_MEDIA = "https://api.bilibili.com/x/v3/fav/resource/list"             // 分页获取收藏夹视频
const MATCH_API_LIST_MEDIA = "https://api.bilibili.com/x/v3/fav/resource/list*"      // 监听请求匹配   
const API_GET_MYINFO = "https://api.bilibili.com/x/space/v2/myinfo"                  // 获取用户信息
const API_GET_FAVLIST = "https://api.bilibili.com/x/v3/fav/folder/created/list-all"  // 获取用户的收藏夹列表      




/**
 * 监听消息传递事件（TODO）
 * 当接收到消息时，根据消息类型执行相应的处理
 * 
 * @param {Object} request - 发送的消息对象，包含消息类型等信息
 * @param {Object} sender - 发送消息的发送者信息
 * @param {Function} sendResponse - 发送响应的函数，用于向消息发送方发送响应
 */
chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
  // from content.js
  if (request.type === "loadFinish") {
    console.log("页面加载完成");
    sendResponse({ msg: "msg received" });
  }
  // from popup.js
  if (request.type === "buttonClicked") {
    sendResponse({ msg: "msg received" });
  }
});



/**
 * 封装带有Chrome插件标记的请求
 * 
 * @param {string} url - 请求的URL
 * @param {string} method - HTTP请求方法，默认为GET
 * @returns {Promise<Object>} 返回一个Promise对象，解析为响应数据
 */
const fetchFromExt = async (url, method) => {
  const response = await fetch(url, {
    method: method || "GET",
    headers: {
      "X-Extension-Request": "true", // 添加标记，防止被chrome.webRequest.onBeforeSendHeaders重复拦截，不然会无限重复发送相同的请求
    },
  })

  if (!response.ok) {
    throw new Error(`API请求失败, 状态码: ${response.status}`);
  }

  const res = await response.json();
  // console.log(`Response of ${url}`, res.data)
  return res;
}


/**
 * 记录上一次监听到的请求URL，用于过滤连续重复请求
 */
let lastUrl = null;


/**
 * 验证是否要忽略该请求   
 * - 忽略插件发出的请求  
 * - 忽略连续重复请求  
 * - 忽略无效请求  
 * 
 * @param {Object} details - 请求详情
 * @param {string} details.url - 请求URL
 * @param {Object} details.requestHeaders - 请求头
 * @returns {boolean} 是否要忽略该请求
 */
const needToSkipRequest = (details) => {
  // 1.忽略插件发出的请求 (否则插件发出的请求也会被监听到，导致无限重复发送请求)
  const isExtensionRequest = details.requestHeaders?.some(
    (header) => header.name === "X-Extension-Request" && header.value === "true"
  );
  if (isExtensionRequest) return true;

  // 2.忽略连续重复请求 (切换收藏夹时，B站可能会连发两个相同的分页请求，不知道为什么)
  if (lastUrl === details.url) return true;
  lastUrl = details.url;

  // 3.忽略无效请求 (初次打开收藏夹页面，B站可能会发送 list?media_id=0 这种无效请求，不知道为什么)
  const url = new URL(details.url);
  const mediaId = url.searchParams.get('media_id');
  if (!mediaId || mediaId === "0") return true;

  return false;
}

/**
 *  监听收藏夹页面「分页获取收藏视频列表」的请求
 * 
 *  1.获取当前页面分页请求的响应内容 (因为没办法直接拿到响应体，所以只能监听请求 -> 复制并发送相同请求 -> 拿到响应体)
 *  2.获取其中的失效视频  
 *  3.通过失效视频的 bvid 查询备份的视频标题，将“已失效视频”替换掉
 *  4.把替换过标题的失效视频列表发送给 content.js 去执行 DOM 更新操作
 * 
 * @param {Object} details - 拦截到的请求详细信息
 * @param {string} details.url - 请求URL
 * @param {string} details.method - 请求方法
 * @param {Object} details.requestHeaders - 请求头信息(包含cookie)
 */
const listener = async (details) => {
  try {
    if (needToSkipRequest(details)) return;

    // 1. 获取当前页面分页请求的响应内容
    const res = await fetchFromExt(details.url, details.method);

    // 2. 获取其中的失效视频
    const invalidMedias = res.data?.medias?.filter(media => media.attr != 0) || [];   // attr: 是否失效 0-正常 1-其他原因删除 9-up主自己删除

    //    获取其中的当前收藏夹信息
    const favInfo = res.data?.info;
    const favId = favInfo?.id;
    if (favId === undefined) {
      throw new Error("从分页请求响应中获取收藏夹 ID 失败")
    }

    // 3. 通过失效视频的 bvid 查询备份的视频标题，将“已失效视频”替换掉
    const { [STORAGE_BACKUP_KEY]: backedUpFavs} =  await chrome.storage.local.get([STORAGE_BACKUP_KEY]);
    const backedUpFav = backedUpFavs?.[favId];
    if (backedUpFav === undefined) {
      throw new Error(`收藏夹 ${favInfo.title}(${favId}) 的备份数据不存在`);
    }
    //    用备份标题替换失效标题
    invalidMedias.forEach(media => {
      media.title = backedUpFav[media.bvid]?.title || "未备份失效视频标题";
    });

    // 4. 把替换过标题的失效视频列表发送给 content.js 去执行 DOM 更新操作
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, {
      type: "replaceInvalidTitles",
      data: invalidMedias,
    });
  } catch (err) {
    console.error(err);
  }
}



/**
 * 监听分页请求
 * 
 * @param {Function} callback - 回调函数
 * @param {Object} filter - 监听哪些请求
 * @param {Array} extraInfoSpec - 指定需要哪些额外信息(可选)
 *   - requestHeaders: 提供请求头信息
 *   - extraHeaders: 提供额外的请求头信息(如Cookie等)
 */
chrome.webRequest.onBeforeSendHeaders.addListener(
  listener,
  { urls: [MATCH_API_LIST_MEDIA] },
  ["requestHeaders", "extraHeaders"]
);



/**
 * 获取并保存用户ID
 * 
 * @returns {Promise<string>} 用户ID
 * @throws {Error} 请求获取到的用户ID为空
 */
const saveMid = async () => {
  const res = await fetchFromExt(API_GET_MYINFO);

  const mid = res.data?.profile?.mid;
  if (mid === undefined) {
    throw new Error("请求获取到的用户ID为空");
  }

  await chrome.storage.local.set({ [STORAGE_MID_KEY]: mid });
  return mid;
};




/**
 * 获取并保存用户收藏夹列表
 * 
 * @param {string} mid 用户ID
 * @returns {Promise<Array>} 用户收藏夹列表
 * @throws {Error} 请求获取到的收藏夹列表为空
 */
const saveFavList = async (mid) => {
  const res = await fetchFromExt(`${API_GET_FAVLIST}?up_mid=${mid}`);

  const favlist = res.data?.list?.map((fav) => ({
    id: fav.id,             // 收藏夹ID
    cnt: fav.media_count,   // 收藏夹视频数量
    mid: fav.mid,           // 用户ID
    title: fav.title,       // 收藏夹标题
  }));
  if (favlist === undefined) {
    throw new Error("请求获取到的收藏夹列表为空");
  }

  await chrome.storage.local.set({ [STORAGE_FAVLIST_KEY]: favlist});
  return favlist;
};



/**
 * 全量备份单个收藏夹 (所有视频)
 * 
 * 单个收藏夹内可能发生的所有情况:
 *     1. 新增收藏
 *     2. 取消收藏
 *     3. 视频失效
 * 
 * 全量备份逻辑:  
 *   准备一个空的集合 updates  
 *   遍历收藏夹中的所有视频，可能发生的所有情况:  
 *     1. 有效视频，备份存在 -> 左边存入集合   
 *     2. 有效视频，备份不存在 -> 左边存入集合（新增收藏）  
 *     3. 失效视频，备份存在 -> 右边存入集合（视频失效）  
 *     4. 失效视频，备份不存在 -> 跳过  
 *     5. 没有视频，备份存在 -> 跳过（取消收藏）  
 *   用 updates 去替换掉整个收藏夹的备份
 * 
 * 
 * 可以保证:  
 *     1. 幂等性（多次执行，备份的最终状态是一致的）  
 *     2. 排除掉未备份的失效视频，收藏夹中的视频和备份视频信息之间是 1:1 对应的关系  
 *     2. 已备份的失效视频信息不会丢失，除非取消收藏  
 * 
 * 
 * @param favId 收藏夹ID 
 * @throws {Error} 分页请求响应数据为空
 */
const backupOneFavFull = async (favId) => {
  // 1. 分页获取当前收藏夹所有视频
  const mediaList = [];  // 存放当前收藏夹所有视频 (只保存需要备份的数据)
  const pageSize = 40;   // 该参数目前最大值为40
  let page = 1;
  let res = null;

  do {
    res = await fetchFromExt(`${API_LIST_MEDIA}?media_id=${favId}&pn=${page}&ps=${pageSize}`);
    // 可能会因为API变动或请求失败导致无响应数据，此时要作为异常抛出，否则会被认为是取消收藏
    if (!res.data) {
      throw new Error("分页请求响应数据为空");   
    }
    const pageMedias = res.data.medias || [];    // 收藏夹内无视频时 medias = null
    // 对于每条视频，将备份以下信息，参数含义见：https://socialsisteryi.github.io/bilibili-API-collect/docs/fav/list.html
    mediaList.push(...pageMedias.map(media => ({
      bvid: media.bvid,    // 视频的BV号
      avid: media.id,      // 视频的AV号
      title: media.title,  // 视频标题
      attr: media.attr,    // 是否失效 0-正常 1-其他原因删除 9-up主自己删除
      up: {
        mid: media.upper?.mid,    // up主id
        name: media.upper?.name,  // up主名称
      }
    })));
    page += 1;
  } while (res.data?.has_more);


  // 2. 更新当前收藏夹备份
  let { [STORAGE_BACKUP_KEY]: backedUpFavs } = await chrome.storage.local.get([STORAGE_BACKUP_KEY]);
  backedUpFavs = backedUpFavs || {};              // 应对 undefined 的情况
  const backedUpFav = backedUpFavs[favId] || {};  // 当前收藏夹的备份数据

  let updates = {};
  for (const media of mediaList) {
    if (media.attr === 0) {
      // 有效视频，不管备份存不存在，都是左边存入
      updates[media.bvid] = media;
    } else {
      // 失效视频，只有备份存在，才右边存入
      if (backedUpFav[media.bvid]) {
        updates[media.bvid] = backedUpFav[media.bvid];
      }
    }
  }

  const updatedFavs = {
    ...backedUpFavs,
    [favId]: updates,
  }
  await chrome.storage.local.set({ [STORAGE_BACKUP_KEY]: updatedFavs });
};


/**
 * 全量备份所有收藏夹
 * 
 * 收藏夹列表可能发生的所有情况:
 *     1. 新增收藏夹
 *     2. 删除收藏夹
 * 
 * @throws {Error} 部分收藏夹备份失败
 */
const backupAllFavsFull = async () => {
  const { [STORAGE_FAVLIST_KEY]: favlist } = await chrome.storage.local.get([STORAGE_FAVLIST_KEY])
  let { [STORAGE_BACKUP_KEY]: backedUpFavs } = await chrome.storage.local.get([STORAGE_BACKUP_KEY]);
  backedUpFavs = backedUpFavs || {};
  
  // 如果收藏夹被删除，不再保留其备份
  for (const favId of Object.keys(backedUpFavs)) {
    if (!favlist.some(fav => fav.id === parseInt(favId))) {
      delete backedUpFavs[favId];
      // console.log("delete:", favId)
    }
  }
  await chrome.storage.local.set({ [STORAGE_BACKUP_KEY]: backedUpFavs });


  // 收集错误，最后一起抛出，保证单个收藏夹失败不影响其他收藏夹执行备份
  const errors = [];
  // 全量备份所有收藏夹
  for (const fav of favlist) {
    try {
      await backupOneFavFull(fav.id);
    } catch (err) {
      console.error(`收藏夹${fav.title}(${fav.id})备份失败:`, err);
      errors.push(err)
    }
  }
  if (errors.length > 0) {
    throw new Error("部分收藏夹备份失败")
  }

  // 注意下面这种写法可能会因为并发过高触发限流，导致请求失败。任何一个请求失败，Promise.all就不会再继续执行剩下的任务，导致数据不全
  // const tasks = favlist.map(fav => backupFavMedias(fav.id, fav.title));
  // await Promise.all(tasks);
}



/**
 * 获取用户ID  
 * 获取用户收藏夹列表  
 * 全量备份所有收藏夹
 */
const backup = async () => {
  try {
    const mid = await saveMid();  
    await saveFavList(mid);       
    await backupAllFavsFull()   
  } catch (err) {
    console.error(err);
  }
};


/**
 * 限定自动备份的时机:
 *     chrome.runtime.onInstalled: 安装或更新插件
 *     chrome.runtime.onStartup: 使用某个user profile启动浏览器
 * 
 * 否则从 idle 中唤醒变为 active 也会执行一次
 * 参考: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
 */
chrome.runtime.onInstalled.addListener(() => {
  backup();
});

chrome.runtime.onStartup.addListener(() => {
  backup();
});
