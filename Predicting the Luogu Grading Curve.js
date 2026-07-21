// ==UserScript==
// @name         预测洛谷等级分趋势图
// @namespace    http://tampermonkey.net/
// @version       2.0
// @description  预测你的等级分！
// @author       a_small_OIer
// @match        https://www.luogu.com.cn/user/*
// @grant        GM_xmlhttpRequest
// @connect      luogu.ac.cn
// @require      https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js
// @run-at       document-end
// ==/UserScript==
(function() {
    'use strict';
    function waitForElement(selector, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const check = () => {
                const el = document.querySelector(selector);
                if (el) resolve(el);
                else if (Date.now() - start > timeout) reject(new Error(`元素 ${selector} 加载超时`));
                else setTimeout(check, 200);
            };
            check();
        });
    }
    function getUid(){
        const match = window.location.pathname.match(/\/user\/(\d+)/);
        return match ? match[1] : null;
    }
    function parseHistoryData(){
        const contextEl = document.getElementById('lentille-context');
        if (!contextEl) throw new Error('未找到 #lentille-context');
        const raw = contextEl.textContent;
        const parsed = JSON.parse(raw);
        const elo = parsed?.data?.elo;
        if (!Array.isArray(elo) || elo.length === 0) throw new Error('elo数据无效或为空');
        return elo;
    }
    function fetchPredictions(uid) {
        return new Promise((resolve, reject) => {
            const url = `https://luogu.ac.cn/api/v1/user/${uid}/rating-predictions`;
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                onload: function(response){
                    try{
                        const json = JSON.parse(response.responseText);
                        resolve(json);
                    }catch (e){
                        reject(new Error('解析预测API响应失败'));
                    }
                },
                onerror: function(err){
                    reject(err);
                }
            });
        });
    }
    function isoToUnix(iso){
        return new Date(iso).getTime() / 1000;
    }
    function buildFullData(history, predictions) {
        const sortedHistory = history.slice().sort((a, b) => a.time - b.time).map(item => ({
    ...item,
    previousRating: item.rating - (item.prevDiff || 0)
}));
        const rawItems = predictions?.items || [];
        const validItems = rawItems.filter(item => {
            const warnings = item.warnings || [];
            return !warnings.some(w => w.includes('赛前等级分不低于本场等级分阈值'));
        });
        const predData = validItems.map(item => ({
            isPredicted: true,
            rating: item.predicted_rating,
            time: isoToUnix(item.end_time),
            latest: false,
            contest: {
                id: item.contest_id,
                startTime: isoToUnix(item.start_time),
                endTime: isoToUnix(item.end_time),
                name: item.contest_name
            },
            userCount: 0,
            prevDiff: item.predicted_delta,
            previous: {
                rating: item.predicted_rating - item.predicted_delta,
                time: null,
                latest: false,
                contest: null,
                userCount: 0,
                prevDiff: null
            },
            previousRating: item.predicted_rating - item.predicted_delta
        }));
        const full = [...sortedHistory, ...predData];
        full.sort((a, b) => {
            if (a.time !== b.time) return a.time - b.time;
            return (a.previousRating || 0) - (b.previousRating || 0);
        });
        const firstPredIdx = full.findIndex(d => d.isPredicted);
        if (firstPredIdx > 0) {
            const prevItem = full[firstPredIdx - 1];
            if (prevItem && !prevItem.isPredicted) {
                const placeholder = {
                    ...prevItem,
                    isPredicted: true,
                    isPlaceholder: true,
                };
                full.splice(firstPredIdx, 0, placeholder);
            }
        }
        return full;
    }
    function formatTime(ts){
        const d = new Date((ts + 8 * 3600) * 1000);
        const year = d.getUTCFullYear();
        const month = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        const hours = String(d.getUTCHours()).padStart(2, '0');
        const minutes = String(d.getUTCMinutes()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}`;
    }
    function prepareContainer(){
        let existingCard = null;
        const cardById = document.querySelector('div.l-card:has(#rating-chart)');
        if(cardById){
            existingCard = cardById;
        }else{
            const cards = document.querySelectorAll('div.l-card');
            for(const card of cards){
                const header = card.querySelector('.header h3.lfe-h3');
                if(header && header.textContent.trim() === '比赛等级分趋势图') {
                    existingCard = card;
                    break;
                }
            }
        }
        if (!existingCard){
            console.log('[等级分曲线预测]未找到原有卡片，不创建新卡片，图表将不显示');
            return null; // 不新建
        }
        const header = existingCard.querySelector('.header');
        while(existingCard.firstChild){
            existingCard.removeChild(existingCard.firstChild);
        }
        if (header) existingCard.appendChild(header);
        const chartDiv = document.createElement('div');
        chartDiv.id = 'rating-chart';
        chartDiv.style.cssText = 'width: 100%; height: 320px;';
        existingCard.appendChild(chartDiv);
        const footer = document.createElement('div');
        footer.style.cssText = `
            margin-top: 8px;
            font-size: 12px;
            color: #999;
            text-align: right;
            border-top: 1px solid #f0f0f0;
            padding: 8px 20px 0 20px;
        `;
        footer.innerHTML = `
            <span style="display:inline-block; background:#eee; border-radius:50%; width:16px; height:16px; line-height:16px; text-align:center; color:#666; font-weight:bold; margin-right:4px;">!</span>
            虚线部分为预测，不代表最终等级分变动<br>数据来源 洛谷档案馆 luogu.ac.cn
        `;
        existingCard.appendChild(footer);
        return chartDiv;
    }
    function renderChart(container, data){
        if(!container)
            return;
        const myChart = echarts.init(container);
        const historical = data.filter(d => !d.isPredicted);
        const predictedFull = data.filter(d => d.isPredicted);
        const maxRating = Math.max(...data.map(d => d.rating));
        const yMax = Math.ceil(maxRating / 400) * 400 || 400;
        function buildSeriesItems(arr, isPredictedSeries = false){
            return arr.map(item => {
                const base = {
                    value: [item.time * 1000, item.rating],
                    symbol: item.isPlaceholder ? 'none' : 'circle',
                    symbolSize: 8,
                    rawInfo: item
                };
                if (isPredictedSeries) {
                    if (item.isPlaceholder) {
                        base.itemStyle = { color: 'transparent', borderColor: 'transparent' };
                    } else {
                        base.itemStyle = {
                            color: 'rgba(255,255,255,0.4)',
                            borderColor: 'rgba(93,173,226,0.6)',
                            borderWidth: 1.5
                        };
                    }
                } else {
                    base.itemStyle = {
                        color: '#fff',
                        borderColor: '#5dade2',
                        borderWidth: 2
                    };
                }
                if(item.rating === maxRating && !item.isPlaceholder){
                    if(isPredictedSeries) {
                        base.itemStyle = {
                            color: 'rgba(255,255,255,0.4)',
                            borderColor: 'rgba(231,76,60,0.6)',
                            borderWidth: 1.5
                        };
                    }else{
                        base.itemStyle = {
                            color: '#fff',
                            borderColor: '#e74c3c',
                            borderWidth: 2
                        };
                    }
                }
                return base;
            });
        }
        const option = {
            grid: {
                left: 0,
                right: 15,
                top: 25,
                bottom: 20,
                containLabel: true
            },
            xAxis: {
                type: 'time',
                axisLine: { lineStyle: { color: '#ccc' } },
                axisLabel: {
                    color: '#555',
                    fontSize: 12,
                    formatter: function(value) {
                        const d = new Date(value);
                        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
                    }
                },
                splitLine: { show: false }
            },
            yAxis: {
                type: 'value',
                min: 0,
                max: yMax,
                interval: 400,
                axisLine: { show: false },
                axisLabel: { color: '#555', fontSize: 12 },
                splitLine: { show: true, lineStyle: { color: '#e0e0e0', type: 'solid' } }
            },
            tooltip: {
                trigger: 'item',
                backgroundColor: 'rgba(42,42,42,0.95)',
                borderColor: 'transparent',
                borderRadius: 4,
                padding: [12, 16],
                textStyle: { color: '#fff' },
                formatter: function(params) {
                    const item = params.data.rawInfo;
                    if (!item || item.isPlaceholder) return '';
                    const isPred = item.isPredicted || false;
                    const titlePrefix = isPred ? '[预测] ' : '';
                    const start = formatTime(item.contest.startTime);
                    const end = formatTime(item.contest.endTime);
                    let prevRating = 0, diff = 0;
                    if(item.previous && item.previous.rating !== undefined) {
                        prevRating = item.previous.rating;
                        diff = item.prevDiff || 0;
                    }else{
                        prevRating = item.rating - (item.prevDiff || 0);
                        diff = item.prevDiff || 0;
                    }
                    let diffColor, diffDisplay;
                    if(diff === 0){
                        diffColor = '#888';
                        diffDisplay = '±0';
                    }else if(diff > 0){
                        diffColor = '#4caf50';
                        diffDisplay = '+' + diff;
                    }else{
                        diffColor = '#e74c3c';
                        diffDisplay = diff;
                    }
                    return `
                        <div style="font-size:14px; font-weight:bold; margin-bottom:4px;">${titlePrefix}${item.contest.name}</div>
                        <div style="font-size:12px; color:#a0a0a0; margin-bottom:6px;">${start} ~ ${end}</div>
                        <div style="font-size:14px;">
                            等级分：<span style="color:#fff; font-weight:bold;">${prevRating}</span>
                            <span style="color:${diffColor}; font-weight:bold;"> ${diffDisplay}</span>
                            = <span style="color:#fff; font-weight:bold;">${item.rating}</span>
                        </div>
                    `;
                }
            },
            series: [{
                name: '历史比赛',
                type: 'line',
                data: buildSeriesItems(historical, false),
                smooth: false,
                lineStyle: { type: 'solid', color: '#5dade2', width: 2.5 },
                animationDuration: 1500,
                animationEasing: 'cubicOut'
            }, {
                name: '预测比赛',
                type: 'line',
                data: buildSeriesItems(predictedFull, true),
                smooth: false,
                lineStyle: {
                    type: 'dashed',
                    color: '#5dade2',
                    width: 2.5,
                    dash: [8, 6],
                    opacity: 0.6
                },
                animationDuration: 1500,
                animationEasing: 'cubicOut'
            }]
        };
        myChart.setOption(option);
        myChart.on('click', function(params) {
            const item = params.data?.rawInfo;
            if (!item || item.isPlaceholder) return;
            const contestId = item.contest?.id;
            if(contestId){
                window.open(`https://www.luogu.com.cn/contest/${contestId}`, '_blank');
            }
        });
        const resizeHandler = () => myChart.resize();
        window.addEventListener('resize', resizeHandler);
        const observer = new ResizeObserver(resizeHandler);
        observer.observe(container);
    }
    async function main(){
        try{
            const uid = getUid();
            if(!uid){
                console.warn('[等级分曲线预测]未找到用户ID');
                return;
            }
            let history;
            try{
                history = parseHistoryData();
            }catch (e){
                console.error('[等级分曲线预测]解析历史数据失败', e);
                return;
            }
            let predictions = null;
            try{
                predictions = await fetchPredictions(uid);
            }catch (e){
                console.warn('[等级分曲线预测]获取预测数据失败，只显示历史比赛数据', e);
                predictions = { items: [] };
            }
            const fullData = buildFullData(history, predictions);
            if(fullData.length === 0){
                console.warn('[等级分曲线预测]无数据可展示');
                return;
            }
            const container = prepareContainer();
            if(!container)
                return;
            await new Promise(resolve => setTimeout(resolve, 100));
            renderChart(container, fullData);
        }catch (error){
            console.error('[等级分曲线预测]脚本运行出错:', error);
        }
    }
    if(document.readyState === 'complete') {
        main();
    }else{
        window.addEventListener('load', main);
    }
})();