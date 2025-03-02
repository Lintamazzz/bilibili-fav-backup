/**
 * CSS 选择器  
 * 用于获取当前收藏夹页面所有视频的标题元素
 */
const VIDEO_TITLE_SELECTOR = ".fav-list-main .items .bili-video-card__details div[title] a";


/**
 * 监听消息  
 * 当接收到消息时，根据消息类型执行相应的处理
 * 
 * @param {Object} request - 接收到的消息对象，包含消息类型和数据
 * @param {Object} sender - 消息发送者的信息
 * @param {Function} sendResponse - 用于向发送者回复消息的回调函数
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 监听来自 background 的消息，接收当前页面的失效视频列表，并使用其中的备份标题替换当前页面的失效标题
    if (request.type === "replaceInvalidTitles") {
        const invalidMedias = request.data;
        // console.log("备份数据:", invalidMedias);

        if (invalidMedias.length > 0) {
            debouncedReplaceTitles(invalidMedias)
        }
    }
});

/**
 * 获取当前页面所有视频标题对应的 \<a> 标签列表
 *
 * 1. 首先尝试直接从 DOM 获取标题元素
 * 2. 如果未找到，则使用 MutationObserver 监听 DOM 变化
 * 3. 设置 5 秒超时机制避免无限等待
 * 
 * @returns {Element[] | Promise<Element[]>} 返回包含所有视频标题 \<a> 标签的数组
 * @throws {Error} 未获取到 or 获取超时
 */
const getTitles = () => {
    const titles = document.querySelectorAll(VIDEO_TITLE_SELECTOR);
    if (titles.length > 0) {
        return [...titles];       // NodeList 转为 Element[]
    } 
    return new Promise((resolve, reject) => {
        const observer = new MutationObserver((mutationsList, observer) => {
            const titles = document.querySelectorAll(VIDEO_TITLE_SELECTOR);
            if (titles.length > 0) {
                resolve([...titles]);    
            } else {
                reject(new Error('未获取到 titles'));
            }
            observer.disconnect();       // 停止监听
        });

        observer.observe(document.body, { childList: true, subtree: true });

        setTimeout(() => {
            observer.disconnect();
            reject(new Error('获取 titles 超时'));
        }, 5000);
    })
}

/**
 * 替换页面上失效视频的标题
 * 
 * 1. 获取页面上所有视频标题元素
 * 2. 遍历失效视频列表，查找对应的标题元素
 * 3. 替换标题文本和提示信息
 * 
 * @param {Array<Object>} invalidMedias - 失效视频列表
 * @param {string} invalidMedias[].bvid - 视频的 BV 号
 * @param {string} invalidMedias[].title - 备份标题
 * @param {string} invalidMedias[].intro - 视频简介
 * @param {number} invalidMedias[].attr - 是否失效 0-正常 1-其他原因删除 9-up主自己删除
 */
const replaceTitles = async (invalidMedias) => {
    try {
        const titles = await getTitles();
        // console.log("视频标题列表:", titles)

        invalidMedias.forEach(media => {
            let title = titles.find(title => title.href.includes(media.bvid)); 
            if (title) {
                title.textContent = media.title
                title.title = media.intro + `\n\n${media.attr === 9 ? "up主自己删除": "其他原因删除"}`
            } else {
                console.error(`未找到匹配的元素: ${media.bvid}`)
            }
        })
    } catch (err) {
        console.error("替换失效标题出错:", err);
    }
}


/**
 * 创建一个简单版本的防抖函数
 * @param {Function} fn - 需要防抖的函数
 * @param {number} delay - 防抖延迟时间（毫秒）
 * @returns {Function} 返回一个防抖处理后的函数
 */
const debounce = (fn, delay) => {
    let timer = null;
    return (...args) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
};


/**
 * 使用防抖包装 replaceTitles 函数，延迟 300ms 执行，避免在以下情况重复执行：
 * - 快速切换收藏夹页面
 * - 连续触发的分页请求
 * - 短时间内收到多次相同的消息
 */
const debouncedReplaceTitles = debounce(replaceTitles, 300);
