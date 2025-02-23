/**
 * background.js
 * 
 * 何时运行：插件安装、启用、打开浏览器、更新/重新加载插件（后台运行 自动执行一次备份）
 * 何时停止：插件移除、禁用、关闭浏览器
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
const STORAGE_BACKUP_KEY = "all_medias";   // 所有收藏夹中所有视频的信息备份
const STORAGE_MID_KEY = "mid";             // 用户ID
const STORAGE_FAVLIST_KEY = "favlist";     // 用户收藏夹列表
const API_LIST_MEDIA = "https://api.bilibili.com/x/v3/fav/resource/list"          // 分页获取收藏夹视频
const MATCH_API_LIST_MEDIA = "https://api.bilibili.com/x/v3/fav/resource/list*"   // 监听请求匹配   
const API_GET_MYINFO = "https://api.bilibili.com/x/space/v2/myinfo"   // 获取用户信息
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
 * @returns {Promise} 返回一个Promise对象，解析为响应数据
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
 *  监听收藏夹页面「分页获取收藏视频列表」的请求
 * 
 *  1.获取当前收藏夹页面的视频列表（因为没办法直接拿到响应体，所以只能监听请求 -> 复制并发送相同请求 -> 拿到响应体）
 *  2.找到其中的已失效视频
 *  3.使用其bvid查询备份的视频标题
 *  4.发送消息给content.js 用备份的视频标题替换"已失效视频"
 * 
 */
chrome.webRequest.onBeforeSendHeaders.addListener(
  async (details) => {
    try {
      // 检查请求头是否包含标记，没有标记说明是浏览器发的请求，有标记说明是插件发的请求，需要跳过，否则会无限发送重复的请求
      const isExtensionRequest = details.requestHeaders?.some(
        (header) => header.name === "X-Extension-Request" && header.value === "true"
      );

      if (!isExtensionRequest) {
        // console.log("This is a browser request.");
      } else {
        // console.log("This is an extension request, skip it.");
        return;
      }

      const res = await fetchFromExt(details.url, details.method);
      const invalidMedias = res.data?.medias?.filter((media) => media.attr != 0); // attr: 是否失效 0-正常 1-其他原因删除 9-up主自己删除

      const favId = res.data?.info?.id;
      if (favId === undefined) {
        throw new Error("未获取到当前所在收藏夹ID")
      }

      const { [STORAGE_BACKUP_KEY]: medias} =  await chrome.storage.local.get([STORAGE_BACKUP_KEY]);
      if (medias === undefined) {
        throw new Error("未获取到备份数据");
      }

      const favMedias = medias[favId];
      if (favMedias === undefined) {
        throw new Error(`收藏夹${favId}的备份数据不存在`);
      }

      // 通过 bvid 查询失效视频的备份数据，替换标题后发送给 content.js 去执行 DOM 更新操作
      invalidMedias.forEach(media => {
        media.title = favMedias[media.bvid]?.title || "未备份失效视频标题";
      });
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      chrome.tabs.sendMessage(tab.id, {
        type: "replaceInvalidTitles",
        data: invalidMedias,
      });

    } catch (err) {
      console.error("监听请求获取响应体时发生错误:", err);
      throw err;
    }
  },
  { urls: [MATCH_API_LIST_MEDIA] },
  ["requestHeaders", "extraHeaders"]
);



/**
 * 获取并保存用户ID
 * 
 * @returns {Promise<string>} 用户ID
 */
const saveMid = async () => {
  try {
    const res = await fetchFromExt(API_GET_MYINFO);

    const mid = res.data?.profile?.mid;
    if (mid === undefined) {
      throw new Error("用户ID为空");
    }

    await chrome.storage.local.set({ [STORAGE_MID_KEY]: mid });

    return mid;
  } catch (err) {
    console.error("获取用户ID时出错:", err);
    throw err;
  }
};




/**
 * 获取并保存用户收藏夹列表
 * 
 * @param {string} mid 用户ID
 * @Return {Promise<Array>} 用户收藏夹列表
 */
const saveFavList = async (mid) => {
  try {
    const res = await fetchFromExt(`${API_GET_FAVLIST}?up_mid=${mid}`);

    const favlist = res.data?.list?.map((fav) => ({
      id: fav.id,             // 收藏夹ID
      cnt: fav.media_count,   // 收藏夹视频数量
      mid: fav.mid,           // 用户ID
      title: fav.title,       // 收藏夹标题
    }));
    if (favlist === undefined) {
      throw new Error("收藏夹列表为空");
    }

    await chrome.storage.local.set({ [STORAGE_FAVLIST_KEY]: favlist});

    return favlist;
  } catch (err) {
    console.error("获取收藏夹列表时出错:", err);
    return err;
  }
};



/**
 * 备份单个收藏夹的所有视频信息
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
 */
const backupFavMedias = async (favId) => {
  try {
    const mediaList = [];  // 存放单个收藏夹所有视频
    const pageSize = 40;   // 该参数目前最大值为40
    let page = 1;
    let res = null;

    // 分页获取当前收藏夹所有视频
    do {
      res = await fetchFromExt(`${API_LIST_MEDIA}?media_id=${favId}&pn=${page}&ps=${pageSize}`);
      // 对于每条视频，将备份以下信息，参数含义见：https://socialsisteryi.github.io/bilibili-API-collect/docs/fav/list.html
      mediaList.push(...res.data?.medias?.map(media => ({
        bvid: media.bvid,    // 视频的BV号
        avid: media.id,      // 视频的AV号
        title: media.title,  // 视频标题
        attr: media.attr,    // 是否失效 0-正常 1-其他原因删除 9-up主自己删除
        up: {
          mid: media.upper?.mid,    // up主id
          name: media.upper?.name,  // up主名称
        },
        time: {
          duration: media.duration,   // 视频时长
          fav: media.fav_time,        // 收藏时间
        },
        cnt: {
          play: media.cnt_info?.play,       // 播放数
          danmaku: media.cnt_info?.danmaku, // 弹幕数
        }
      })));
      page += 1;
    } while (res.data?.has_more);

    // 获取所有收藏夹的备份
    let { [STORAGE_BACKUP_KEY]: medias } = await chrome.storage.local.get([STORAGE_BACKUP_KEY]);
    medias = medias || {};    // 应对 undefined 的情况
    const favMedias = medias[favId] || {};  // 当前收藏夹的备份数据

    let updates = {};
    for (const media of mediaList) {
      if (media.attr === 0) {
        // 有效视频，不管备份存不存在，都是左边存入
        updates[media.bvid] = media;
      } else {
        // 失效视频，只有备份存在，才右边存入
        if (favMedias[media.bvid]) {
          updates[media.bvid] = favMedias[media.bvid];
        }
      }
    }

    // 更新单个收藏夹的备份
    const updatedMedias = {
      ...medias,
      [favId]: updates,
    }

    // 保存更新
    await chrome.storage.local.set({ [STORAGE_BACKUP_KEY]: updatedMedias });

  } catch(err) {
    console.error("备份单个收藏夹时出错:",err);
    throw err;
  }
};


/**
 * 备份所有收藏夹
 * 
 * 收藏夹列表可能发生的所有情况:
 *     1. 新增收藏夹
 *     2. 删除收藏夹
 * 
 */
const backupAllFavMedias = async () => {
  try {
    const { [STORAGE_FAVLIST_KEY]: favlist } = await chrome.storage.local.get([STORAGE_FAVLIST_KEY])
    let { [STORAGE_BACKUP_KEY]: medias } = await chrome.storage.local.get([STORAGE_BACKUP_KEY]);
    medias = medias || {};
    
    // 如果收藏夹被删除，不再保留其备份
    for (const favId of Object.keys(medias)) {
      if (!favlist.some(fav => fav.id === parseInt(favId))) {
        delete medias[favId];
        // console.log("delete:", favId)
      }
    }
    await chrome.storage.local.set({ [STORAGE_BACKUP_KEY]: medias });

    // 备份所有收藏夹
    for (const fav of favlist) {
      await backupFavMedias(fav.id);
    }

    // 这种写法可能会因为并发过高触发限流，导致请求失败。任何一个请求失败，Promise.all就不会再继续执行剩下的任务，导致数据不全
    // const tasks = favlist.map(fav => backupFavMedias(fav.id, fav.title));
    // await Promise.all(tasks);
  } catch(err) {
    console.error("备份所有收藏夹时出错:",err);
    throw err;
  }
}

const backup = async () => {
  const mid = await saveMid();  
  await saveFavList(mid);     // 获取最新的收藏夹列表
  await backupAllFavMedias()  // 全量备份
};


// 安装或更新插件、打开浏览器时自动执行一次备份
function main() {
  backup();  
}

main();   
