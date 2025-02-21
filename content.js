chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {

    if (request.type === "replaceInvalidTitles") {
        // 从 background 获取当前页面的失效视频列表（标题已替换为备份标题）
        const invalidMedias = request.data;
        // console.log("备份数据:", invalidMedias);

        
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

});

/**
 * 获取当前页面所有视频标题对应的<a>标签列表
 * 
 * @returns Promise<Array>
 */
function getTitles() {
    return new Promise((resolve, reject) => {
        const observer = new MutationObserver((mutationsList, observer) => {
            const titles = document.querySelectorAll('.fav-list-main .items .bili-video-card__details div[title] a');
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
