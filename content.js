let debounceTimer = null;
const VIDEO_TITLE_SELECTOR = ".fav-list-main .items .bili-video-card__details div[title] a";



chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {

    if (request.type === "replaceInvalidTitles") {
        // 从 background 获取当前页面的失效视频列表（标题已替换为备份标题）
        const invalidMedias = request.data;
        // console.log("备份数据:", invalidMedias);

        // 防抖处理：接收到多个连续的消息时，只执行最后一个，避免重复或不必要的DOM操作（连续相同的分页请求、快速切换收藏夹）
        if (debounceTimer) {
            clearTimeout(debounceTimer); 
        }
        debounceTimer = setTimeout(() => replaceTitles(invalidMedias), 300); // 延迟 300ms 执行操作，期间收到相同消息不会重复执行
    }

});

/**
 * 获取当前页面所有视频标题对应的<a>标签列表
 * 
 * @returns Promise<Array>
 */
const getTitles = () => {
    // 先尝试直接获取，没找到再监听变化
    const titles = document.querySelectorAll(VIDEO_TITLE_SELECTOR);
    if (titles.length > 0) {
        return [...titles];
    } 
    return new Promise((resolve, reject) => {
        const observer = new MutationObserver((mutationsList, observer) => {
            const titles = document.querySelectorAll(VIDEO_TITLE_SELECTOR);
            if (titles.length > 0) {
                resolve([...titles]);    // NodeList 转为 Array
            } else {
                reject('未获取到 titles');
            }
            observer.disconnect();       // 停止监听
        });

        // 配置 MutationObserver 监听 DOM 树的子元素变化
        observer.observe(document.body, { childList: true, subtree: true });

        // 设置超时机制，避免一直等待
        setTimeout(() => {
            observer.disconnect();
            reject('获取 titles 超时');
        }, 5000); // 设置 5 秒超时
    })
}

/**
 * 通过修改 DOM 来替换页面上的失效视频标题
 * 
 * @param {Array} invalidMedias 页面上的失效视频列表（其中标题已替换为备份标题）
 */
const replaceTitles = async (invalidMedias) => {
    try {
        // 获取当前页面中所有视频标题对应的<a>标签列表
        const titles = await getTitles();
        // console.log("视频标题列表:", titles);

        // 替换页面上的失效视频标题
        invalidMedias.forEach(media => {
            let title = titles.find(title => title.href.includes(media.bvid)); 
            if (title) {
                title.textContent = media.title
            } else {
                console.error(`未找到匹配的元素: ${media.bvid}`)
            }
        })
    } catch (err) {
        console.error("替换失效标题失败:", err);
        throw err;
    }
}