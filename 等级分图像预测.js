// ==UserScript==
// @name         洛谷等级分预测
// @namespace    https://www.luogu.com.cn/user/1523280
// @version      3.1
// @description  预测你的等级分曲线和比赛状况！
// @author       a_small_OIer & Sakument_tree
// @match        https://www.luogu.com.cn/contest/*
// @match        https://www.luogu.com.cn/user/*
// @grant        GM_xmlhttpRequest
// @connect      luogu.ac.cn
// @require      https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js
// @run-at       document-end
// ==/UserScript==
(function (){
  'use strict';
  /**
   * 通用 GM_xmlhttpRequest Promise 封装
   * @param {string} url - 请求地址
   * @returns {Promise<object>} 解析后的 JSON 对象
   */
  function gmRequest(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        onload: function (resp) {
          try {
            resolve(JSON.parse(resp.responseText));
          } catch (e) {
            reject(e);
          }
        },
        onerror: reject
      });
    });
  }
  function isoToUnix(iso) {
    return new Date(iso).getTime() / 1000;
  }
  function formatTime(ts) {
    const d = new Date((ts + 8 * 3600) * 1000);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const hours = String(d.getUTCHours()).padStart(2, '0');
    const minutes = String(d.getUTCMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }
  const path = window.location.pathname;
  if (path.match(/^\/contest\/\d+/)) {
    (function () {
      const contestId = window.location.pathname.match(/\/contest\/(\d+)/)?.[1];
      if (!contestId) {
        console.warn('未找到比赛 ID');
        return;
      }
      // -------- 参数配置 --------
      const CACHE_KEY = 'luogu_contest_pred_cache';
      const PAGE_SIZE = 100;
      function getCacheTTL(mode) {
        return mode === 'official' ? 15 * 24 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000;
      }
      let ratingMode = null;
      let dataMap = {};
      let isAllFetched = false;
      let isLoading = false;
      let initialized = false;
      let isUnrated = false;
      let initLock = false;
      let domCheckTimer = null;
      // -------- 缓存 --------
      function getCache() {
        try {
          const raw = localStorage.getItem(CACHE_KEY);
          return raw ? JSON.parse(raw) : {};
        } catch { return {}; }
      }
      function setCache(cache) {
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
        } catch { }
      }
      function getRowBackgroundColor(row) {
        const userDiv = row.querySelector('.user');
        if (userDiv) {
          const bg = userDiv.style.backgroundColor;
          if (bg) return bg;
        }
        return null;
      }
      function fetchContestPredictions(page = 1) {
        const url = `https://luogu.ac.cn/api/v1/contest/${contestId}?page=${page}&page_size=${PAGE_SIZE}`;
        return gmRequest(url);
      }
      function removePredictionUI() {
        const headerRow = document.querySelector('.header-wrap .header');
        if(headerRow){
          const oldHeader = headerRow.querySelector('.header-container[data-prediction-header]');
          if(oldHeader)
            oldHeader.remove();
        }
        const rows = document.querySelectorAll('.row-wrap .row');
        rows.forEach(row => {
          const cell = row.querySelector('.problem[data-prediction-cell]');
          if (cell) cell.remove();
        });
      }
      function removeFooter() {
        const footer = document.querySelector('#prediction-footer');
        if (footer) footer.remove();
      }
      let height = -1;
      function setCellFullHeight(cell, row) {
        if(!cell || !row)
          return;
        if(height === -1){
          height = row.clientHeight;
        }
        if(height > 0){
          cell.style.height = height + 'px';
          cell.style.minHeight = height + 'px';
          cell.style.boxSizing = 'border-box';
        }else{
          cell.style.height = '100%';
          cell.style.minHeight = '100%';
          cell.style.alignSelf = 'stretch';
        }
      }
      function fillCurrentRows() {
        if (!window.location.hash.includes('scoreboard')) return;
        if (isUnrated) {
          removePredictionUI();
          removeFooter();
          return;
        }
        if (fail === 2) {
          removePredictionUI();
          updateFooter();
          return;
        }
        const rows = document.querySelectorAll('.row-wrap .row');
        if (rows.length === 0) return;
        ensureHeader();
        rows.forEach(row => {
          let cell = row.querySelector('.problem[data-prediction-cell]');
          if (!cell) {
            cell = document.createElement('div');
            cell.className = 'problem';
            cell.dataset.predictionCell = 'true';
            cell.style.cssText = 'flex: 0 0 80px; display: flex; flex-direction: column; justify-content: center; align-items: center;';
            row.appendChild(cell);
          }
          setCellFullHeight(cell, row);
          const bgColor = getRowBackgroundColor(row);
          if (bgColor) {
            cell.style.backgroundColor = bgColor;
          } else {
            cell.style.backgroundColor = '';
          }
          const uid = getUidFromRow(row);
          if (!uid) {
            cell.innerHTML = '';
            const scoreDiv = document.createElement('div');
            scoreDiv.className = 'td-score';
            scoreDiv.textContent = '-';
            cell.appendChild(scoreDiv);
            const runtimeDiv = document.createElement('div');
            runtimeDiv.className = 'td-runtime';
            runtimeDiv.textContent = '';
            cell.appendChild(runtimeDiv);
            return;
          }
          const info = dataMap[uid];
          if (!info) {
            cell.innerHTML = '';
            const scoreDiv = document.createElement('div');
            scoreDiv.className = 'td-score';
            const placeholder = document.createElement('span');
            placeholder.textContent = '获取中...';
            placeholder.style.color = 'rgba(0,0,0,0.55)';
            placeholder.style.fontSize = '13px';
            scoreDiv.appendChild(placeholder);
            cell.appendChild(scoreDiv);
            const runtimeDiv = document.createElement('div');
            runtimeDiv.className = 'td-runtime';
            runtimeDiv.textContent = '\u00A0';
            cell.appendChild(runtimeDiv);
            return;
          }
          const delta = info.delta;
          const newRating = info.newRating;
          const warnings = info.warnings || [];
          cell.innerHTML = '';
          const scoreDiv = document.createElement('div');
          scoreDiv.className = 'td-score';
          const deltaSpan = document.createElement('span');
          deltaSpan.style.fontWeight = 'bold';
          if (delta === null || delta === undefined) {
            deltaSpan.textContent = '-';
            deltaSpan.style.color = 'rgba(0,0,0,0.55)';
          } else if (delta > 0) {
            deltaSpan.style.color = 'rgb(82, 196, 26)';
            deltaSpan.textContent = `+${delta}`;
          } else if (delta < 0) {
            deltaSpan.style.color = 'rgb(231, 76, 60)';
            deltaSpan.textContent = `${delta}`;
          } else {
            deltaSpan.style.color = 'rgba(0,0,0,0.55)';
            deltaSpan.textContent = '±0';
          }
          scoreDiv.appendChild(deltaSpan);
          if (warnings.length > 0) {
            const warnIcon = document.createElement('span');
            warnIcon.textContent = ' ⓘ';
            warnIcon.style.cursor = 'help';
            warnIcon.style.fontSize = '14px';
            warnIcon.style.color = 'rgba(0,0,0,0.55)';
            warnIcon.title = warnings.join('\n');
            scoreDiv.appendChild(warnIcon);
          }
          cell.appendChild(scoreDiv);
          const runtimeDiv = document.createElement('div');
          runtimeDiv.className = 'td-runtime';
          if (newRating !== null && newRating !== undefined) {
            runtimeDiv.textContent = `新: ${newRating}`;
            runtimeDiv.style.color = 'rgba(0,0,0,0.55)';
            runtimeDiv.style.fontSize = '12px';
          } else {
            runtimeDiv.textContent = '\u00A0';
          }
          cell.appendChild(runtimeDiv);
        });
        updateFooter();
      }
      function getUidFromRow(row) {
        const link = row.querySelector('.user a[href^="/user/"]');
        if (link) {
          const match = link.href.match(/\/user\/(\d+)/);
          return match ? match[1] : null;
        }
        return null;
      }
      let fail = 0;
      async function loadData() {
        if (isLoading || isUnrated || fail === 2) return;
        if (isAllFetched) {
          fillCurrentRows();
          return;
        }
        isLoading = true;
        fail = 0;
        try{
          const firstPageData = await fetchContestPredictions(1);
          if (!firstPageData || !firstPageData.contest) {
            throw new Error('无法获取比赛信息');
          }
          const currentRatingMode = firstPageData.contest.rating_mode || null;
          console.log(`[等级分预测] 当前 rating_mode: ${currentRatingMode}`);
          if (currentRatingMode === 'unrated') {
            ratingMode = currentRatingMode;
            isUnrated = true;
            removePredictionUI();
            isLoading = false;
            return;
          }
          const cache = getCache();
          const now = Date.now();
          const cachedEntry = cache[contestId];
          if (cachedEntry) {
            const cachedMode = cachedEntry.ratingMode;
            const cachedTime = cachedEntry.timestamp;
            const ttl = getCacheTTL(cachedMode);
            if (cachedMode === currentRatingMode && (now - cachedTime < ttl)) {
              console.log('[等级分预测] 缓存有效，直接使用');
              ratingMode = cachedMode;
              isUnrated = (ratingMode === 'unrated');
              const cachedData = cachedEntry.data || [];
              cachedData.forEach(item => {
                dataMap[String(item.uid)] = {
                  delta: item.delta,
                  newRating: item.rating,
                  warnings: item.warnings || []
                };
              });
              isAllFetched = true;
              isLoading = false;
              fillCurrentRows();
              return;
            } else {
              console.log('[等级分预测] 缓存无效，重新获取');
            }
          }
          console.log('[等级分预测] 开始分页获取数据...');
          ratingMode = currentRatingMode;
          isUnrated = false;
          const firstItems = firstPageData.items || [];
          firstItems.forEach(item => {
            dataMap[String(item.uid)] = {
              delta: item.delta,
              newRating: item.rating,
              warnings: item.warnings || []
            };
          });
          ensureHeader();
          fillCurrentRows();
          let total = firstPageData.total || 0;
          let page = 2;
          while (true) {
            if (Object.keys(dataMap).length >= total) break;
            const data = await fetchContestPredictions(page);
            const items = data.items || [];
            if (items.length === 0) break;
            items.forEach(item => {
              dataMap[String(item.uid)] = {
                delta: item.delta,
                newRating: item.rating,
                warnings: item.warnings || []
              };
            });
            fillCurrentRows();
            total = data.total || total;
            page++;
          }
          const allData = Object.keys(dataMap).map(uid => ({
            uid: parseInt(uid),
            delta: dataMap[uid].delta,
            rating: dataMap[uid].newRating,
            warnings: dataMap[uid].warnings
          }));
          cache[contestId] = {
            data: allData,
            ratingMode: ratingMode,
            timestamp: Date.now()
          };
          setCache(cache);
          isAllFetched = true;
          console.log('[等级分预测] 全部数据获取完成，已缓存');
        } catch (e) {
          const cache = getCache();
          const cachedEntry = cache[contestId];
          if (cachedEntry && cachedEntry.data) {
            console.warn(`[等级分预测] 加载数据失败:${e}\n使用过期缓存作为降级`);
            fail = 1;
            const cachedData = cachedEntry.data || [];
            cachedData.forEach(item => {
              dataMap[String(item.uid)] = {
                delta: item.delta,
                newRating: item.rating,
                warnings: item.warnings || []
              };
            });
            isAllFetched = true;
            fillCurrentRows();
          } else {
            console.error(`[等级分预测] 加载数据失败:${e}\n无缓存可用`);
            fail = 2;
          }
        } finally {
          isLoading = false;
          fillCurrentRows();
        }
      }
      function ensureHeader() {
        if (isUnrated) {
          const headerRow = document.querySelector('.header-wrap .header');
          if (headerRow) {
            const oldHeader = headerRow.querySelector('.header-container[data-prediction-header]');
            if (oldHeader) oldHeader.remove();
          }
          return;
        }
        const headerRow = document.querySelector('.header-wrap .header');
        if (!headerRow) return;
        const oldHeader = headerRow.querySelector('.header-container[data-prediction-header]');
        if (oldHeader) oldHeader.remove();
        let headerHtml = '';
        let titleText = '';
        if (ratingMode === 'prediction') {
          headerHtml = '<span>Δ</span><span style="color:rgba(0,0,0,0.55);font-size:11px;display:block;">（预测）</span>';
          titleText = '等级分变动（预测结果，仅供参考）';
        } else if (ratingMode === 'official') {
          headerHtml = '<span>Δ</span>';
          titleText = '等级分变动（正式结果）';
        } else {
          headerHtml = '<span>Δ</span>';
          titleText = '等级分变动';
        }
        const newHeader = document.createElement('div');
        newHeader.className = 'header-container';
        newHeader.dataset.predictionHeader = 'true';
        newHeader.style.cssText = 'flex: 0 0 80px; text-align: center; display: flex; flex-direction: column; justify-content: center; cursor: help;';
        newHeader.title = titleText;
        newHeader.innerHTML = headerHtml;
        headerRow.appendChild(newHeader);
      }
      function updateFooter() {
        if (isUnrated) {
          const footer = document.querySelector('#prediction-footer');
          if (footer) footer.remove();
          return;
        }
        let footer = document.querySelector('#prediction-footer');
        if (!footer) {
          const container = document.querySelector('.l-card') || document.querySelector('main');
          if (!container) return;
          footer = document.createElement('div');
          footer.id = 'prediction-footer';
          footer.style.cssText = 'padding: 8px 16px; font-size: 12px; color: #999; text-align: right; border-top: 1px solid #eee; margin-top: 8px;';
          container.appendChild(footer);
        }
        if (fail === 2) {
          footer.textContent = '等级分预测：获取数据失败';
          return;
        }
        const cache = getCache();
        const entry = cache[contestId];
        if (entry) {
          const d = new Date(entry.timestamp);
          const timeStr = d.toLocaleString('zh-CN', { hour12: false });
          const modeStr = entry.ratingMode ? ` (${entry.ratingMode})` : '';
          const ttl = getCacheTTL(entry.ratingMode);
          const ttlHours = Math.round(ttl / (60 * 60 * 1000));
          const ttlDisplay = ttlHours >= 24 ? `${Math.round(ttlHours / 24)} 天` : `${ttlHours} 小时`;
          footer.textContent = `等级分预测：数据最后更新于 ${timeStr}${modeStr}`;
          if (fail === 1) {
            footer.textContent += '（缓存刷新失败）';
          } else {
            footer.textContent += `（缓存 ${ttlDisplay}）`;
          }
          footer.textContent += '  数据来源：洛谷档案馆 luogu.ac.cn';
        } else {
          footer.textContent = '等级分预测：暂无缓存数据';
        }
      }
      async function init() {
        if (initialized) {
          if (isAllFetched) fillCurrentRows();
          else loadData();
          return;
        }
        initialized = true;
        if (!document.querySelector('.row-wrap .row')) {
          await new Promise(resolve => {
            const observer = new MutationObserver(() => {
              if (document.querySelector('.row-wrap .row')) {
                observer.disconnect();
                resolve();
              }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => {
              observer.disconnect();
              resolve();
            }, 5000);
          });
        }
        setupObserver();
        await loadData();
      }
      function setupObserver() {
        const target = document.querySelector('.row-wrap') || document.querySelector('main');
        if (!target) return;
        let timer = null;
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (isUnrated) {
              removePredictionUI();
              return;
            }
            if (isAllFetched || isLoading) {
              fillCurrentRows();
            } else {
              loadData();
            }
          }, 500);
        });
        observer.observe(target, {
          childList: true,
          subtree: true,
          attributes: false,
          characterData: false
        });
      }
      function triggerInit() {
        if (!window.location.hash.includes('scoreboard')) return;
        if (initLock) return;
        initLock = true;
        clearTimeout(domCheckTimer);
        domCheckTimer = setTimeout(() => {
          if (document.querySelector('.row-wrap .row')) {
            if (!initialized) {
              init();
            } else {
              if (isAllFetched) fillCurrentRows();
              else loadData();
            }
          } else {
            const observer = new MutationObserver((mutations, obs) => {
              if (document.querySelector('.row-wrap .row')) {
                obs.disconnect();
                if (!initialized) {
                  init();
                } else {
                  if (isAllFetched) fillCurrentRows();
                  else loadData();
                }
              }
            });
            observer.observe(document.body, {
              childList: true,
              subtree: true
            });
            setTimeout(() => {
              observer.disconnect();
            }, 10000);
          }
          initLock = false;
        }, 300);
      }
      function startWatching() {
        window.addEventListener('hashchange', triggerInit);
        window.addEventListener('popstate', triggerInit);
        const targetNode = document.querySelector('#app') || document.querySelector('main') || document.body;
        const observer = new MutationObserver(() => {
          clearTimeout(window._domCheckTimer);
          window._domCheckTimer = setTimeout(() => {
            triggerInit();
          }, 200);
        });
        observer.observe(targetNode, {
          childList: true,
          subtree: true
        });
        setInterval(() => {
          if (window.location.hash.includes('scoreboard')) {
            triggerInit();
          }
        }, 2000);
      }
      startWatching();
      if (window.location.hash.includes('scoreboard')) {
        setTimeout(triggerInit, 500);
      }
    })();
  }
  else if (path.match(/^\/user\/\d+/)) {
    (function () {
      let lastUid = null;
      let lastPath = null;
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
      function getUid() {
        const match = window.location.pathname.match(/\/user\/(\d+)/);
        return match ? match[1] : null;
      }
      function parseHistoryData() {
        const contextEl = document.getElementById('lentille-context');
        if (!contextEl) throw new Error('未找到 #lentille-context');
        const raw = contextEl.textContent;
        const parsed = JSON.parse(raw);
        const elo = parsed?.data?.elo;
        return elo;
      }
      function fetchPredictions(uid) {
        const url = `https://luogu.ac.cn/api/v1/user/${uid}/rating-predictions`;
        return gmRequest(url);
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
          previousRating: item.predicted_rating - item.predicted_delta,
          warnings: item.warnings || []
        }));
        const full = [...sortedHistory, ...predData];
        full.sort((a, b) => {
          if (a.time !== b.time) return a.time - b.time;
          return (a.previousRating || 0) - (b.previousRating || 0);
        });
        if (full.length > 0 && full[0].isPredicted) {
          full[0].isFirst = true;
        } else {
          let firstHistoricalFound = false;
          for (const item of full) {
            if (!item.isPredicted && !firstHistoricalFound) {
              item.isFirst = true;
              firstHistoricalFound = true;
              break;
            }
          }
        }
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
      function gatPageType() {
        const path = window.location.pathname;
        const match = path.match(/^\/user\/(\d+)/);
        if (!match) return '';
        const rest = path.substring(match[0].length);
        if (rest === '' || rest === '/') return 'profile';
        if (/^\/user\/\d+\/practice/.test(window.location.pathname)) return 'practice';
        return '';
      }
      function prepareContainer(pagetype) {
        let existingCard = null;
        const cardById = document.querySelector('div.l-card:has(#rating-chart)');
        if (cardById) {
          existingCard = cardById;
        } else {
          const cards = document.querySelectorAll('div.l-card');
          for (const card of cards) {
            const header = card.querySelector('.header h3.lfe-h3');
            if (header && header.textContent.trim() === '比赛等级分趋势图') {
              existingCard = card;
              break;
            }
          }
        }
        if (existingCard) {
          const header = existingCard.querySelector('.header');
          while (existingCard.firstChild) {
            existingCard.removeChild(existingCard.firstChild);
          }
          if (header) existingCard.appendChild(header);
          const chartDiv = document.createElement('div');
          chartDiv.id = 'rating-chart';
          chartDiv.style.cssText = 'width: 100%; height: 320px;';
          existingCard.appendChild(chartDiv);
          return chartDiv;
        }
        const card = document.createElement('div');
        card.className = 'l-card';
        card.style.marginBottom = '20px';
        card.setAttribute('data-v-176b97b3', '');
        card.setAttribute('data-v-d3b68fa4', '');
        card.setAttribute('data-v-4ad5148e', '');
        card.setAttribute('data-v-754e1ea4-s', '');
        const header = document.createElement('div');
        header.className = 'header';
        header.setAttribute('data-v-03592857', '');
        const h3 = document.createElement('h3');
        h3.className = 'lfe-h3';
        h3.textContent = '比赛等级分趋势图';
        h3.setAttribute('data-v-03592857', '');
        header.appendChild(h3);
        card.appendChild(header);
        const span = document.createElement('span');
        span.className = 'lfe-caption';
        span.textContent = '选中记录后可打开比赛页面';
        span.setAttribute('data-v-03592857', '');
        header.appendChild(span);
        card.appendChild(header);
        const chartDiv = document.createElement('div');
        chartDiv.id = 'rating-chart';
        chartDiv.setAttribute('data-v-03592857', '');
        chartDiv.style.cssText = 'width: 100%; height: 320px;';
        card.appendChild(chartDiv);
        let inserted = false;
        if (pagetype === 'profile') {
          const allCards = document.querySelectorAll('.l-card');
          let refCard = null;
          for (const c of allCards) {
            const h = c.querySelector('.header h3');
            if (h && h.textContent.trim().includes('做题趋势热度图')) {
              refCard = c;
              break;
            }
          }
          if (refCard) {
            refCard.insertAdjacentElement('afterend', card);
            inserted = true;
          }
        } else if (pagetype === 'practice') {
          const container = document.querySelector('.user-main') || document.body;
          let targetCard = null;
          const allCards = container.querySelectorAll('.l-card');
          for (const c of allCards) {
            const emptyBlock = c.querySelector('.empty-block');
            if (emptyBlock) {
              const h3 = emptyBlock.querySelector('h3.title');
              if (h3 && h3.textContent.trim() === '该用户设置了完全隐私保护，无法查看练习记录') {
                targetCard = c;
                break;
              }
            }
            const directH3 = c.querySelector('h3.lfe-h3');
            if (directH3 && directH3.textContent.trim() === '尝试过的题目') {
              targetCard = c;
              break;
            }
          }
          if (targetCard) {
            targetCard.insertAdjacentElement('beforebegin', card);
          }
          inserted = true;
        }
        if (!inserted) return null;
        return chartDiv;
      }
      function renderChart(container, data) {
        if (!container) return;
        const myChart = echarts.init(container);
        const historicalData = data.filter(d => !d.isPredicted);
        const historicalMax = historicalData.length > 0 ? Math.max(...historicalData.map(d => d.rating)) : 0;
        const predictedData = data.filter(d => d.isPredicted && !d.isPlaceholder);
        const predictedMax = predictedData.length > 0 ? Math.max(...predictedData.map(d => d.rating)) : -Infinity;
        const showPredictedMax = predictedMax >= historicalMax;
        data.forEach(item => {
          if (!item.isPredicted) {
            item.isHistoricalMax = (item.rating === historicalMax);
          } else {
            item.isPredictedMax = (item.rating === predictedMax && showPredictedMax);
          }
        });
        const historical = data.filter(d => !d.isPredicted);
        const predictedFull = data.filter(d => d.isPredicted);
        const maxRating = Math.max(...data.map(d => d.rating));
        const yMax = Math.ceil(maxRating / 400) * 400 || 400;
        function buildSeriesItems(arr, isPredictedSeries = false) {
          return arr.map(item => {
            const base = {
              value: [item.time * 1000, item.rating],
              symbol: item.isPlaceholder ? 'none' : 'circle',
              symbolSize: 5,
              rawInfo: item
            };
            if (isPredictedSeries) {
              if (item.isPlaceholder) {
                base.itemStyle = { color: 'transparent', borderColor: 'transparent' };
              } else if (item.isPredictedMax) {
                base.itemStyle = {
                  color: 'rgba(255,255,255,0.4)',
                  borderColor: 'rgba(240,112,7,0.6)',
                  borderWidth: 2
                };
              } else {
                base.itemStyle = {
                  color: 'rgba(255,255,255,0.4)',
                  borderColor: 'rgba(93,173,226,0.6)',
                  borderWidth: 1.5
                };
              }
            } else {
              if (item.isHistoricalMax) {
                base.itemStyle = {
                  color: '#fff',
                  borderColor: '#e74c3c',
                  borderWidth: 2
                };
              } else {
                base.itemStyle = {
                  color: '#fff',
                  borderColor: '#5dade2',
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
              formatter: function (value) {
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
            formatter: function (params) {
              const item = params.data.rawInfo;
              if (!item || item.isPlaceholder) return '';
              const isPred = item.isPredicted || false;
              const Prefix = isPred ? '[预测] ' : '';
              const start = formatTime(item.contest.startTime);
              const end = formatTime(item.contest.endTime);
              let ratingDisplay = '';
              if (item.isFirst) {
                ratingDisplay = `等级分：<span style="color:#fff; font-weight:bold;">${item.rating}</span>`;
              } else {
                let prevRating = 0, diff = 0;
                if (item.previous && item.previous.rating !== undefined) {
                  prevRating = item.previous.rating;
                  diff = item.prevDiff || 0;
                } else {
                  prevRating = item.rating - (item.prevDiff || 0);
                  diff = item.prevDiff || 0;
                }
                let diffColor, diffDisplay;
                if (diff === 0) {
                  diffColor = '#888';
                  diffDisplay = '±0';
                } else if (diff > 0) {
                  diffColor = '#4caf50';
                  diffDisplay = '+' + diff;
                } else {
                  diffColor = '#e74c3c';
                  diffDisplay = diff;
                }
                ratingDisplay = `
                  等级分：<span style="color:#fff; font-weight:bold;">${prevRating}</span>
                  <span style="color:${diffColor}; font-weight:bold;"> ${diffDisplay}</span>
                  = <span style="color:#fff; font-weight:bold;">${item.rating}</span>
                `;
              }
              let extraText = '';
              if (item.isHistoricalMax) {
                extraText += '<div style="font-style:italic; color:#fff; margin-top:4px;">达成历史最高</div>';
              }
              if (item.isPredictedMax) {
                extraText += '<div style="font-style:italic; color:#fff; margin-top:4px;">预计达成历史最高</div>';
              }
              if (item.warnings && item.warnings.length > 0) {
                for (const warn of item.warnings) {
                  extraText += `<div style="color:rgb(170,170,170); margin-top:2px;">ⓘ ${warn}</div>`;
                }
              }
              return `
                <div style="font-size:14px; font-weight:bold; margin-bottom:4px;">${item.contest.name}</div>
                <div style="font-size:12px; color:#a0a0a0; margin-bottom:6px;">${start} ~ ${end}</div>
                <div style="font-size:14px;">${Prefix}${ratingDisplay}</div>
                ${extraText}
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
        myChart.on('click', function (params) {
          const item = params.data?.rawInfo;
          if (!item || item.isPlaceholder) return;
          const contestId = item.contest?.id;
          if (contestId) {
            window.open(`https://www.luogu.com.cn/contest/${contestId}`, '_blank');
          }
        });
        const resizeHandler = () => myChart.resize();
        window.addEventListener('resize', resizeHandler);
        const observer = new ResizeObserver(resizeHandler);
        observer.observe(container);
      }
      async function main() {
        try {
          const pageType = gatPageType();
          if (pageType !== 'profile' && pageType !== 'practice') return;
          const uid = getUid();
          if (!uid) {
            console.warn('[等级分预测] 未找到用户 ID');
            return;
          }
          let history;
          try {
            history = parseHistoryData();
          } catch (e) {
            console.error('[等级分预测] 解析历史数据失败', e);
            return;
          }
          let predictions = null;
          let fetchError = false;
          try {
            predictions = await fetchPredictions(uid);
          } catch (e) {
            console.warn('[等级分预测] 获取预测数据失败，只显示历史比赛数据', e);
            fetchError = true;
            predictions = { items: [] };
          }
          const fullData = buildFullData(history, predictions);
          if (fullData.length === 0) {
            console.log('[等级分预测] 无数据可展示');
            return;
          }
          const chartDiv = prepareContainer(pageType);
          if (!chartDiv) {
            console.error('[等级分预测] 无法创建或找到卡片容器');
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
          renderChart(chartDiv, fullData);
          const card = chartDiv.parentNode;
          if (!card) return;
          const hasPrediction = fullData.some(d => d.isPredicted && !d.isPlaceholder);
          let showFooter = false;
          let footerText = '';
          if (fetchError) {
            showFooter = true;
            footerText = '获取预测数据失败，只显示历史比赛数据';
          } else if (hasPrediction) {
            showFooter = true;
            footerText = '虚线部分为预测，不代表最终等级分变动<br>数据来源：洛谷档案馆 luogu.ac.cn';
          }
          const oldFooter = card.querySelector('.rating-footer');
          if (oldFooter) oldFooter.remove();
          if (showFooter) {
            const footer = document.createElement('div');
            footer.className = 'rating-footer';
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
              ${footerText}
            `;
            card.appendChild(footer);
          }
        } catch (error) {
          console.error('[等级分预测] 脚本运行出错:', error);
        }
      }
      function checkAndRun() {
        const uid = getUid();
        const path = window.location.pathname;
        if (uid && (uid !== lastUid || path !== lastPath)) {
          lastUid = uid;
          lastPath = path;
          main();
        }
      }
      function init() {
        checkAndRun();
        window.addEventListener('popstate', checkAndRun);
        const originalPush = history.pushState;
        const originalReplace = history.replaceState;
        history.pushState = function () {
          originalPush.apply(this, arguments);
          checkAndRun();
        };
        history.replaceState = function () {
          originalReplace.apply(this, arguments);
          checkAndRun();
        };
      }
      if (document.readyState === 'complete') {
        init();
      } else {
        window.addEventListener('load', init);
      }
    })();
  }
})();