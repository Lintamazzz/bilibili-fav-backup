/**
 * background.js
 * 
 * 自动备份时机:  
 *    安装或更新插件 - 执行一次全量备份
 *    使用某个用户资料启动 Chrome 浏览器 - 如果距离上一次全量备份的时间间隔超过 FULL_BACKUP_INTERVAL，则执行全量备份，否则执行增量备份
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
const STORAGE_LAST_FULL_BACKUP_TIME = "last_full_backup_time";  // 上次全量备份的时间戳
const FULL_BACKUP_INTERVAL = 24 * 60 * 60 * 1000;               // 全量备份的最小时间间隔（24小时）
const STORAGE_INVALID_IDS_KEY = "invalid_ids";                  // 已知的失效视频ID集合（类似于"循环不变量", 需要维护好其语义: 虽然只有增量备份时需要用到, 但在全量备份时也要更新这个集合）

const API_LIST_MEDIA = "https://api.bilibili.com/x/v3/fav/resource/list"             // 分页获取收藏夹视频
const MATCH_API_LIST_MEDIA = "https://api.bilibili.com/x/v3/fav/resource/list?*"     // 监听请求匹配   
const API_GET_MYINFO = "https://api.bilibili.com/x/space/v2/myinfo"                  // 获取用户信息
const API_GET_FAVLIST = "https://api.bilibili.com/x/v3/fav/folder/created/list-all"  // 获取用户的收藏夹列表      
const API_GET_FAV_IDS = "https://api.bilibili.com/x/v3/fav/resource/ids"             // 获取收藏夹所有视频的ID
const API_GET_MEDIA_INFO = "https://api.bilibili.com/x/web-interface/view"           // 获取单个视频详细信息




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
let lastRequestInfo = {
  url: null,
  timestamp: 0
};

/**
 * 验证是否要忽略该请求   
 * - 忽略插件发出的请求  
 * - 忽略连续重复请求（300ms内）  
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
  const now = Date.now();
  if (lastRequestInfo.url === details.url && now - lastRequestInfo.timestamp < 300) {
    return true;
  }
  lastRequestInfo.url = details.url;
  lastRequestInfo.timestamp = now;

  // 3.忽略无效请求 (初次打开收藏夹页面，B站可能会发送 list?media_id=0 这种无效请求，不知道为什么)
  const url = new URL(details.url);
  const mediaId = url.searchParams.get('media_id');
  if (!mediaId || mediaId === "0") return true;

  return false;
}

/**
 *  查询出当前页面上失效视频的备份标题，然后发送给 content.js 去执行 DOM 更新操作
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
 * 监听收藏夹页面的分页请求
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
 * @throws {Error} API响应格式异常、获取到的收藏夹数量不完整
 */
const saveFavList = async (mid) => {
  const res = await fetchFromExt(`${API_GET_FAVLIST}?up_mid=${mid}`);

  // 检查响应格式是否符合预期 (list必须是数组、count不能为0)
  if (!res.data || !Array.isArray(res.data.list) || !res.data.count) {
    throw new Error("API 响应格式异常，可能是接口发生变化");
  }

  // 检查收藏夹列表是否为空、数据是否完整，防止误删备份
  const favlist = res.data.list.map((fav) => ({
    id: fav.id,             // 收藏夹ID
    cnt: fav.media_count,   // 收藏夹视频数量
    mid: fav.mid,           // 用户ID
    title: fav.title,       // 收藏夹标题
  }));
  if (!favlist.length || favlist.length !== res.data.count) {
    throw new Error(`获取到的收藏夹列表有问题：应有 ${res.data.count} 个，实际获取到 ${favlist.length} 个`);
  }

  await chrome.storage.local.set({ [STORAGE_FAVLIST_KEY]: favlist});
  return favlist;
};


/**
 * 获取单个视频的信息
 * 
 * @param {string} bvid - 视频的BV号
 * @returns {Promise<Object>} 视频信息 (attr = 0 表示视频有效)
 * @throws {Error} API响应格式异常、请求错误
 */
const getMediaInfo = async (bvid) => {
  // API文档：https://socialsisteryi.github.io/bilibili-API-collect/docs/video/info.html
  const res = await fetchFromExt(`${API_GET_MEDIA_INFO}?bvid=${bvid}`);

  // 失效视频
  if (res.code !== 0) {
    if (res.code === -404)  return { attr: 1 };  // 一般是其他原因删除
    if (res.code === 62002) return { attr: 9 };  // 一般是up主自己删除
    if (res.code === 62012) return { attr: -1};  // 仅up主可见
    throw new Error(`请求错误, 状态码: ${res.code}`);
  }

  // 检查响应格式
  if (!res.data || !res.data.owner) {
    throw new Error(`API 响应格式不符合预期`)
  }

  // 有效视频
  return {
    bvid: res.data.bvid,    // 视频的BV号
    avid: res.data.aid,     // 视频的AV号
    title: res.data.title,  // 视频标题
    attr: 0,                // 是否失效 0-正常 1-其他原因删除 9-up主自己删除
    up: {
      mid: res.data.owner.mid,    // up主id
      name: res.data.owner.name,  // up主名称
    }
  }
}


/**
 * 增量备份单个文件夹 (只考虑新增收藏)  
 * 
 * 增量备份逻辑:  
 *   获取收藏夹内所有视频的 ID 列表，遍历每一个 ID:    
 *     1. 视频未备份 -> 查询视频详情，如果视频有效，添加到备份中   
 *     2. 视频已备份 -> 跳过   
 * 
 * 可以保证:   
 *     1. 不更新已有备份  
 *     2. 不删除已有备份  
 *     3. 只新增未备份的有效视频，多次执行不会重复备份
 * 
 * 补充：为什么不利用分页请求API，基于收藏时间排序来实现增量查询？  
 *      因为会受到自定义排序的影响，不能保证结果一定是按收藏时间排序的
 * 
 *  @param {string} favId 收藏夹ID 
 *  @throws {Error} API 响应格式异常、未获取到详细信息的视频ID列表
 */
const backupOneFavIncr = async (favId) => {
    // 1. 获取收藏夹内所有视频的 ID 列表  
    const res = await fetchFromExt(`${API_GET_FAV_IDS}?media_id=${favId}`);
    let ids = res.data?.map(item => item.bvid) || [];
    let cnt = ids.length;   // 收藏夹内总的视频个数

    //    检查响应格式是否符合预期
    if (res.code !== 0 || !Array.isArray(res.data)) {
      throw new Error("API 响应格式异常")
    }
    

    // 2. 获取当前收藏夹的备份
    const { [STORAGE_BACKUP_KEY]: backedUpFavs = {} } = await chrome.storage.local.get([STORAGE_BACKUP_KEY]);  
    const backedUpFav = backedUpFavs[favId] || {};  
    //    获取已知的失效视频ID集合
    const { [STORAGE_INVALID_IDS_KEY]: invalidIdsArray = [] } = await chrome.storage.local.get([STORAGE_INVALID_IDS_KEY]);  
    const invalidIds = new Set(invalidIdsArray);

    // 3. 过滤掉备份中已存在的ID、以及已知的失效视频ID
    ids = ids.filter(bvid => !backedUpFav[bvid] && !invalidIds.has(bvid));

    //    如果需要查询的视频较多，就升级为全量备份
    //    增量备份：需要发送 ids.length 次请求
    //    全量备份：需要发送 Math.ceil(cnt / 40) 次请求
    if (ids.length > Math.ceil(cnt / 40)) {
      return await backupOneFavFull(favId);
    }

    // 4. 未备份的有效视频 -> 添加到备份    
    //    未备份的失效视频 -> 加入已知失效ID的集合，减少以后的无用请求
    let inserts = {}
    let errorIds = [];  // 记录获取信息失败的视频ID
    for (const bvid of ids) {
      try {
        const mediaInfo = await getMediaInfo(bvid);
        if (mediaInfo.attr === 0) {
          inserts[bvid] = mediaInfo;
        } else {
          invalidIds.add(bvid);
        }
      } catch (err) {
        errorIds.push(bvid);
        console.error(`获取视频 ${bvid} 的详细信息失败:`, err);
      }
    }
    // console.log("收藏夹: ", favId)
    // console.log("插入的视频: ", inserts)

    // 3. 保存结果
    const updatedFavs = {
      ...backedUpFavs,   // 其他收藏夹保持不变
      [favId]: {
        ...backedUpFav,  // 当前收藏夹已有的数据保持不变
        ...inserts       // 加入新增的数据
      }
    };
    await chrome.storage.local.set({ 
      [STORAGE_BACKUP_KEY]: updatedFavs, 
      [STORAGE_INVALID_IDS_KEY]: Array.from(invalidIds) 
    });

    if (errorIds.length > 0) {
      throw new Error(`获取以下视频的详细信息失败: ${errorIds}`);
    }
}

/**
 * 增量备份所有收藏夹
 * 
 * @param {string} mid 用户ID
 * @throws {Error} 未获取到收藏夹列表、部分收藏夹备份失败
 */
const backupAllFavsIncr = async (mid) => {
  // 1. 获取最新的用户收藏夹列表
  const favlist = await saveFavList(mid);  
  if (favlist === undefined) {
    throw new Error("未获取到收藏夹列表");
  }

  // 2. 增量备份每个收藏夹
  let errorCount = 0;
  for (const fav of favlist) {
    try {
      await backupOneFavIncr(fav.id)
    } catch (err) {
      errorCount += 1;
      console.error(`收藏夹 ${fav.title} (${fav.id}) 增量备份时出错:`, err);
    }
  }
  if (errorCount > 0) {
    throw new Error(`有 ${errorCount} 个收藏夹增量备份出错`);
  }
}


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
 * @param {string} favId 收藏夹ID 
 * @throws {Error} API响应格式异常、获取到的视频数量不完整
 */
const backupOneFavFull = async (favId) => {
  // 1. 分页获取当前收藏夹所有视频
  const mediaList = [];  // 存放当前收藏夹所有视频 (只保存需要备份的数据)
  const pageSize = 40;   // 该参数目前最大值为40
  let page = 1;
  let res = null;

  do {
    res = await fetchFromExt(`${API_LIST_MEDIA}?media_id=${favId}&pn=${page}&ps=${pageSize}`);
    // 检查响应格式是否符合预期 (可能会因为API变动或请求失败导致无响应数据，此时要作为异常抛出，否则会误判为"所有视频都被取消收藏"，从而误删备份数据)
    if (!res.data || res.data.info === undefined || res.data.medias === undefined) {
      throw new Error("API 响应格式异常，可能是接口发生变化");   
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


  // 二次确认，防止误删备份数据
  if (mediaList.length === 0) {
    // 如果一个视频都没获取到，需要进一步确认收藏夹是否真的为空
    if (res.data.info.media_count > 0) {
      throw new Error("收藏夹不为空但未获取到任何视频，可能是 API 异常");
    }
  }
  // 为什么不能用 mediaList.length === res.data.info.media_count 来检查视频数量的完整性？
  // 因为可能会有视频设置了仅up主可见，导致实际能获取到的视频数量就是要比收藏夹视频数 count 要少
  

  // 2. 更新当前收藏夹备份
  const { 
    [STORAGE_BACKUP_KEY]: backedUpFavs = {},
    [STORAGE_INVALID_IDS_KEY]: invalidIdsArray = []
  } = await chrome.storage.local.get([STORAGE_BACKUP_KEY, STORAGE_INVALID_IDS_KEY]);
  const backedUpFav = backedUpFavs[favId] || {};  // 当前收藏夹的备份数据
  const invalidIds = new Set(invalidIdsArray);    // 已知的失效视频ID集合

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
      invalidIds.add(media.bvid);
    }
  }

  const updatedFavs = {
    ...backedUpFavs,   // 其他收藏夹保持不变
    [favId]: updates,  // 当前收藏夹整个替换
  }
  await chrome.storage.local.set({ 
    [STORAGE_BACKUP_KEY]: updatedFavs,
    [STORAGE_INVALID_IDS_KEY]: Array.from(invalidIds)
  });
};


/**
 * 全量备份所有收藏夹
 * 
 * 收藏夹列表可能发生的所有情况:
 *     1. 新增收藏夹
 *     2. 删除收藏夹
 * 
 * @param {string} mid 用户ID
 * @throws {Error} 部分收藏夹备份失败、未获取到收藏夹列表
 */
const backupAllFavsFull = async (mid) => {
  // 1. 获取最新的用户收藏夹列表
  const favlist = await saveFavList(mid);   
  if (favlist === undefined) {
    throw new Error("未获取到收藏夹列表");
  }

  // 2. 检查是否有收藏夹被删除，如果被删除则不再保留其备份数据
  const { [STORAGE_BACKUP_KEY]: backedUpFavs = {} } = await chrome.storage.local.get([STORAGE_BACKUP_KEY]);
  for (const favId of Object.keys(backedUpFavs)) {
    if (!favlist.some(fav => fav.id === parseInt(favId))) {
      delete backedUpFavs[favId];
    }
  }
  await chrome.storage.local.set({ [STORAGE_BACKUP_KEY]: backedUpFavs });

  // 3. 全量备份每个收藏夹
  let errorCount = 0;
  for (const fav of favlist) {
    try {
      await backupOneFavFull(fav.id);
    } catch (err) {
      errorCount += 1;
      console.error(`收藏夹 ${fav.title} (${fav.id}) 全量备份失败:`, err);
    }
  }
  if (errorCount > 0) {
    throw new Error(`有 ${errorCount} 个收藏夹全量备份失败`);
  }

  // 4. 全量备份成功后更新时间戳
  await chrome.storage.local.set({ [STORAGE_LAST_FULL_BACKUP_TIME]: Date.now() }); 

  // 注意下面这种写法可能会因为并发过高触发限流，导致请求失败。任何一个请求失败，Promise.all就不会再继续执行剩下的任务，导致数据不全
  // const tasks = favlist.map(fav => backupFavMedias(fav.id, fav.title));
  // await Promise.all(tasks);
}



/**
 * 限定自动备份的时机:
 *     chrome.runtime.onInstalled: 安装或更新插件 - 执行一次全量备份
 *     chrome.runtime.onStartup: 使用某个user profile启动浏览器 - 如果距离上一次全量备份超过 FULL_BACKUP_INTERVAL，执行全量备份，否则执行增量备份
 * 
 * 否则从 idle 中唤醒变为 active 也会执行一次
 * 参考: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
 */
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const mid = await saveMid();  // 获取当前用户ID
    await backupAllFavsFull(mid); // 全量备份所有收藏夹
  } catch (err) {
    console.error(err);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    // 获取当前用户ID、获取上次全量备份的时间
    const mid = await saveMid(); 
    const { [STORAGE_LAST_FULL_BACKUP_TIME]: lastFullBackupTime = 0 } = 
    await chrome.storage.local.get([STORAGE_LAST_FULL_BACKUP_TIME]);

    const now = Date.now();
    if (now - lastFullBackupTime >= FULL_BACKUP_INTERVAL) {
      await backupAllFavsFull(mid);
    } else {
      await backupAllFavsIncr(mid);
    }
  } catch (err) {
    console.error(err);
  }
});
