
    let globalStats = null
    let currentTab = 'dashboard'
    let currentSelectedClass = ''
    let autoPollingTimer = null

    // ── 管理员密码验证与口令缓存 ─────────────────────────────
    function getAdminToken() {
      return localStorage.getItem('yanxiaogong_admin_token') || sessionStorage.getItem('yanxiaogong_admin_token') || ''
    }

    function setAdminToken(token, remember = true) {
      if (remember) {
        localStorage.setItem('yanxiaogong_admin_token', token)
      } else {
        sessionStorage.setItem('yanxiaogong_admin_token', token)
      }
    }

    function clearAdminToken() {
      localStorage.removeItem('yanxiaogong_admin_token')
      sessionStorage.removeItem('yanxiaogong_admin_token')
    }


    // ── 移动端侧栏抽屉 ───────────────────────────────────────
    function openAdminDrawer() {
      const side = document.getElementById('yxSidebar')
      const back = document.getElementById('yxSidebarBackdrop')
      const btn = document.getElementById('yxMenuBtn')
      if (side) side.classList.add('yx-drawer-open')
      if (back) back.classList.add('show')
      document.body.classList.add('yx-drawer-lock')
      if (btn) btn.setAttribute('aria-expanded', 'true')
    }
    function closeAdminDrawer() {
      const side = document.getElementById('yxSidebar')
      const back = document.getElementById('yxSidebarBackdrop')
      const btn = document.getElementById('yxMenuBtn')
      if (side) side.classList.remove('yx-drawer-open')
      if (back) back.classList.remove('show')
      document.body.classList.remove('yx-drawer-lock')
      if (btn) btn.setAttribute('aria-expanded', 'false')
    }
    function toggleAdminDrawer() {
      const side = document.getElementById('yxSidebar')
      if (side && side.classList.contains('yx-drawer-open')) closeAdminDrawer()
      else openAdminDrawer()
    }
    window.openAdminDrawer = openAdminDrawer
    window.closeAdminDrawer = closeAdminDrawer
    window.toggleAdminDrawer = toggleAdminDrawer

    function showAuthModal(errMsg = '') {
      const modal = document.getElementById('adminAuthModal')
      const errBox = document.getElementById('adminAuthError')
      if (modal) {
        modal.classList.remove('hidden')
        modal.style.display = 'flex'
      }
      if (errBox) {
        if (errMsg) {
          errBox.innerText = errMsg
          errBox.classList.remove('hidden', 'd-none')
          errBox.style.display = 'block'
        } else {
          errBox.innerText = ''
          errBox.classList.add('hidden')
          errBox.style.display = 'none'
        }
      }
      const input = document.getElementById('adminPasswordInput')
      if (input) {
        input.value = ''
        setTimeout(() => input.focus(), 100)
      }
    }

    function hideAuthModal() {
      const modal = document.getElementById('adminAuthModal')
      if (modal) {
        modal.classList.add('hidden')
        modal.style.display = 'none'
      }
      const errBox = document.getElementById('adminAuthError')
      if (errBox) {
        errBox.classList.add('hidden')
        errBox.style.display = 'none'
        errBox.innerText = ''
      }
    }

    function togglePasswordVisibility() {
      const input = document.getElementById('adminPasswordInput')
      if (input) {
        input.type = input.type === 'password' ? 'text' : 'password'
      }
    }

    async function handleAuthSubmit(e) {
      if (e) e.preventDefault()
      const input = document.getElementById('adminPasswordInput')
      const password = (input ? input.value : '').trim()
      const remember = document.getElementById('rememberPasswordCheck')?.checked ?? true
      const btn = document.getElementById('adminAuthSubmitBtn')
      const errBox = document.getElementById('adminAuthError')

      if (!password) {
        if (errBox) {
          errBox.innerText = '请输入管理员密码'
          errBox.classList.remove('hidden', 'd-none')
          errBox.style.display = 'block'
        }
        if (input) input.classList.add('is-invalid')
        return
      }
      if (input) input.classList.remove('is-invalid')

      if (btn) {
        btn.disabled = true
        btn.innerHTML = `<svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> 验证中...`
      }

      try {
        const res = await fetch('/api/admin/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        })
        const json = await res.json()
        if (json.code === 0) {
          const token = (json.data && json.data.token) || password
          setAdminToken(token, remember)
          hideAuthModal()
          showToast('管理员身份验证成功！欢迎进入控制台', 'success')
          startApp()
        } else {
          if (errBox) {
            errBox.innerText = json.message || '密码错误，请重新输入'
            errBox.classList.remove('hidden', 'd-none')
            errBox.style.display = 'block'
          }
          if (input) input.classList.add('is-invalid')
        }
      } catch (err) {
        if (errBox) {
          errBox.innerText = '验证连接异常，请重试: ' + err.message
          errBox.classList.remove('hidden', 'd-none')
          errBox.style.display = 'block'
        }
        if (input) input.classList.add('is-invalid')
      } finally {
        if (btn) {
          btn.disabled = false
          btn.innerHTML = '进入后台'
        }
      }
    }

    function adminLogout() {
      if (confirm('确定要退出管理员登录并锁定后台吗？')) {
        clearAdminToken()
        if (autoPollingTimer) {
          clearInterval(autoPollingTimer)
          autoPollingTimer = null
        }
        showAuthModal('已安全退出登录，请重新输入密码')
      }
    }

    // 封装统一鉴权请求
    async function adminFetch(url, options = {}) {
      const token = getAdminToken()
      options.headers = options.headers || {}
      if (token) {
        if (options.headers instanceof Headers) {
          options.headers.set('x-admin-token', token)
        } else {
          options.headers['x-admin-token'] = token
        }
      }
      const res = await fetch(url, options)
      if (res.status === 401) {
        clearAdminToken()
        showAuthModal('登录口令已过期或未授权，请输入管理员密码')
        throw new Error('未授权')
      }
      return res
    }

    function exportUsersCsv(e) {
      if (e) e.preventDefault()
      window.open(`/api/admin/export/users.csv?token=${encodeURIComponent(getAdminToken())}`, '_blank')
    }
    function exportExamsCsv(e) {
      if (e) e.preventDefault()
      window.open(`/api/admin/export/exams.csv?token=${encodeURIComponent(getAdminToken())}`, '_blank')
    }
    // 页面加载入口
    document.addEventListener('DOMContentLoaded', async () => {
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') closeAdminDrawer()
      })
      window.addEventListener('resize', () => {
        if (window.innerWidth >= 992) closeAdminDrawer()
      })
      // 登录按钮 / 回车键绑定（此前 HTML 无 onclick、JS 未 addEventListener，导致点「进入后台」无反应）
      const authBtn = document.getElementById('adminAuthSubmitBtn')
      if (authBtn) authBtn.addEventListener('click', handleAuthSubmit)
      const authInput = document.getElementById('adminPasswordInput')
      if (authInput) {
        authInput.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault()
            handleAuthSubmit(ev)
          }
        })
      }

      // 检查 hash
      const hash = window.location.hash.replace('#', '')
      if (hash === 'codes') hash = 'dashboard'
      if (['dashboard', 'colleges', 'classes', 'users', 'exams', 'announcement', 'reminder'].includes(hash)) {
        switchTab(hash)
      } else {
        switchTab('dashboard')
      }

      const token = getAdminToken()
      if (token) {
        try {
          const res = await fetch('/api/admin/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
          })
          const json = await res.json()
          if (json.code === 0) {
            hideAuthModal()
            startApp()
            return
          }
        } catch (e) {
          console.warn('自动验证口令失败:', e)
        }
      }
      showAuthModal()
    })

    function startApp() {
      loadAllData()
      if (autoPollingTimer) clearInterval(autoPollingTimer)
      autoPollingTimer = setInterval(() => {
        loadAllData(true)
      }, 15000)
    }

    // 切换 Tab
    function switchTab(tabId) {
      currentTab = tabId
      window.location.hash = tabId

      // 切换导航高亮（侧栏 + 顶栏胶囊）——只点 a.nav-link，避免误伤 li.nav-item
      document.querySelectorAll('#sidebar-menu a.nav-link').forEach(btn => {
        btn.classList.remove('text-indigo-600', 'bg-indigo-50', 'font-semibold', 'active-nav', 'text-indigo-700', 'active')
        btn.classList.add('text-slate-600', 'font-medium')
      })
      const activeNav = document.getElementById(`nav-${tabId}`)
      if (activeNav) {
        activeNav.classList.remove('text-slate-600', 'font-medium')
        activeNav.classList.add('text-indigo-700', 'bg-indigo-50', 'font-semibold', 'active-nav', 'active')
      }
      document.querySelectorAll('#yxCapsuleNav a').forEach(a => a.classList.remove('active'))
      const cap = document.getElementById(`cap-${tabId}`)
      if (cap) cap.classList.add('active')
      if (tabId === 'colleges') renderCollegeCards()

      // 切换视图容器
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'))
      const activeContent = document.getElementById(`tab-${tabId}`)
      if (activeContent) activeContent.classList.add('active')

      // 窄屏：点导航后关闭抽屉
      try {
        if (window.innerWidth < 992) closeAdminDrawer()
      } catch (_) {}

      // 按需加载特定模块
      if (tabId === 'announcement') loadAnnouncementData()
      if (tabId === 'reminder') loadReminderData()
    }

    function refreshCurrentTab(showTip = false) {
      if (showTip) showToast('正在刷新当前页面数据...', 'info')
      loadAllData()
      if (currentTab === 'announcement') loadAnnouncementData()
      if (currentTab === 'reminder') loadReminderData()
    }

    // 全量拉取 Dashboard 与用户数据
    async function loadAllData(isSilent = false) {
      loadCloudStatus()
      try {
        const res = await adminFetch('/api/admin/dashboard')
        const json = await res.json()
        if (json.code === 0 && json.data) {
          globalStats = json.data
          renderDashboard(globalStats)
          populateCollegeFilters(globalStats)
          populateClassSelectOptions(globalStats)
          renderCollegeCards()
          handleUserSearch()
          handleExamSearch()

          // refresh class/college detail if selected
          if (currentSelectedClass) {
            renderCurrentClassDetails(currentSelectedClass)
          }
          if (currentSelectedCollege) {
            renderCurrentCollegeDetails(currentSelectedCollege)
          }
        }
      } catch (err) {
        if (!isSilent) {
          console.error('拉取大屏数据失败:', err)
          if (!(err && err.message === '未授权')) {
            const banner = document.getElementById('yxLoadError')
            if (banner) banner.classList.remove('hidden')
            const text = document.getElementById('yxLoadErrorText')
            if (text) text.textContent = '运营数据没有加载成功。检查网络后重试。'
            if (!globalStats) {
              const usersBody = document.getElementById('usersTableBody')
              if (usersBody) usersBody.innerHTML = '<tr><td colspan="10" class="yx-empty">考生数据加载失败。<button type="button" class="btn btn-ghost" onclick="refreshCurrentTab(true)">重试</button></td></tr>'
              const examsBody = document.getElementById('examsTableBody')
              if (examsBody) examsBody.innerHTML = '<tr><td colspan="8" class="yx-empty">模考流水加载失败。<button type="button" class="btn btn-ghost" onclick="refreshCurrentTab(true)">重试</button></td></tr>'
            }
          }
        }
      }
    }

    // 微信云托管实时探活与状态监控
    async function loadCloudStatus() {
      try {
        const res = await adminFetch('/api/admin/cloud-status')
        const json = await res.json()
        if (json.code === 0 && json.data) {
          const { cloud, sync } = json.data
          const badge = document.getElementById('cloudStatusBadge')
          const text = document.getElementById('cloudStatusText')
          const ping = document.getElementById('cloudPingText')
          const syncText = document.getElementById('cloudLastSyncText')

          if (badge && text && ping) {
            if (cloud.healthy) {
              badge.className = 'yx-status-pill ok'
              text.innerText = `探活正常 (${cloud.statusCode || 200} OK)`
              ping.innerText = `探活延迟: ${cloud.pingMs || 0} ms`
            } else {
              badge.className = 'yx-status-pill bad'
              text.innerText = '云端连接异常'
              ping.innerText = `错误: ${cloud.error || '超时'}`
            }
          }

          if (syncText && sync && sync.lastSyncAt) {
            const diffSec = Math.max(0, Math.round((Date.now() - sync.lastSyncAt) / 1000))
            if (diffSec < 60) {
              syncText.innerText = `最近同步: ${diffSec}秒前`
            } else {
              syncText.innerText = `最近同步: ${Math.round(diffSec / 60)}分钟前`
            }
          }
        }
      } catch (e) {
        console.warn('获取微信云托管状态失败:', e)
      }
    }

    // 渲染总览大屏
    function renderDashboard(data) {
      const loadErr = document.getElementById('yxLoadError')
      if (loadErr) loadErr.classList.add('hidden')
      const chartSkel = document.getElementById('examChartSkel')
      if (chartSkel) chartSkel.classList.add('hidden')
      const ov = data.overview || {}
      document.getElementById('statTotalUsers').innerText = (ov.totalUsers || (data.users ? data.users.length : 0)).toLocaleString()
      document.getElementById('statProfileDone').innerText = (ov.completedProfiles || 0).toLocaleString()
      document.getElementById('statTotalExams').innerText = (ov.totalExamsFinished || (data.allExams ? data.allExams.length : 0)).toLocaleString()
      document.getElementById('statTotalPractices').innerText = (ov.totalPracticesStarted || 0).toLocaleString()
      document.getElementById('statPassRate').innerText = `${ov.examPassRate || 0}%`
      const passChip = document.getElementById('yxPassChipVal')
      if (passChip) passChip.innerText = `${ov.examPassRate || 0}`
      const activeChip = document.getElementById('yxActiveChipVal')
      if (activeChip) activeChip.innerText = `${(ov.activeUsersToday || 0).toLocaleString()}`
      const elTotalEvents = document.getElementById('statTotalEvents')
      if (elTotalEvents) elTotalEvents.innerText = (ov.totalEvents || 0).toLocaleString()
      const elActiveToday = document.getElementById('statActiveToday')
      if (elActiveToday) elActiveToday.innerText = `${(ov.activeUsersToday || 0).toLocaleString()} 人`
      const elTodayEvents = document.getElementById('statTodayEvents')
      if (elTodayEvents) elTodayEvents.innerText = (ov.todayEvents || 0).toLocaleString()

      // 渲染盐小工校园通 · 核心运营指标 (DataCube 实时数据)
      const wx = data.wechatOfficial
      if (wx && wx.visitTotal) {
        const fmtRate = (rate) => {
          const r = Number(rate || 0)
          return r >= 0 ? `↑ ${r}%` : `↓ ${Math.abs(r)}%`
        }
        const periodEl = document.getElementById('wxOfficialPeriodText')
        if (periodEl && wx.refDate) {
          periodEl.innerText = `数据周期：${wx.refDate} 官方核算`
        }
        const totalEl = document.getElementById('wxOfficialTotalUsers')
        if (totalEl) totalEl.innerText = Number(wx.visitTotal || 0).toLocaleString()
        const totalSubEl = document.getElementById('wxOfficialTotalUsersSub')
        if (totalSubEl) {
          const diff = Number(wx.visitTotalDiff || wx.visitUvNew || 0)
          totalSubEl.innerHTML = `<span>${fmtRate(wx.visitTotalGrowthRate)} 日环比 (${diff >= 0 ? '+' + diff : diff}人)</span>`
        }
        const sessionEl = document.getElementById('wxOfficialSessionCnt')
        if (sessionEl) sessionEl.innerText = Number(wx.sessionCnt || 0).toLocaleString()
        const sessionSubEl = document.getElementById('wxOfficialSessionCntSub')
        if (sessionSubEl) {
          sessionSubEl.innerHTML = `<span>昨日访问 PV: ${Number(wx.visitPv || 0).toLocaleString()} 次 (${fmtRate(wx.sessionCntGrowthRate)})</span>`
        }
        const uvEl = document.getElementById('wxOfficialVisitUv')
        if (uvEl) uvEl.innerText = Number(wx.visitUv || 0).toLocaleString()
        const uvSubEl = document.getElementById('wxOfficialVisitUvSub')
        if (uvSubEl) {
          uvSubEl.innerHTML = `<span>人均停留 ${wx.stayTimeUv || 0} 秒 (${fmtRate(wx.visitUvGrowthRate)} 日环比)</span>`
        }
        const newEl = document.getElementById('wxOfficialVisitUvNew')
        if (newEl) newEl.innerText = Number(wx.visitUvNew || 0).toLocaleString()
        const newSubEl = document.getElementById('wxOfficialVisitUvNewSub')
        if (newSubEl) {
          newSubEl.innerHTML = `<span>昨日分享转发 ${wx.sharePv || 0} 次 (${wx.shareUv || 0}人)</span>`
        }
      } else {
        const periodEl = document.getElementById('wxOfficialPeriodText')
        if (periodEl) periodEl.textContent = '暂无微信官方数据'
        ;['wxOfficialTotalUsers', 'wxOfficialSessionCnt', 'wxOfficialVisitUv', 'wxOfficialVisitUvNew', 'wxOfficialTotalUsersStack', 'wxOfficialSessionCntStack'].forEach((id) => {
          const el = document.getElementById(id)
          if (el) el.textContent = '暂无'
        })
      }

      renderDashboardCollegeRank(data)

      // 热门班级渲染（支持点击直达班级查询）
      const classList = data.classStats || data.classGroups || []
      const rankBox = document.getElementById('classRankList')
      if (classList.length > 0) {
        rankBox.innerHTML = classList.slice(0, 8).map((cg, idx) => `
          <div onclick="jumpToClassQuery('${escapeHtml(cg.className)}')" class="yx-rank-row">
            <span class="yx-rank-num ${idx < 3 ? 'top' : ''}">${idx + 1}</span>
            <span class="yx-rank-name">${escapeHtml(cg.className)}</span>
            <span class="yx-rank-count">${cg.studentCount || cg.userCount || 0} 位同学 ›</span>
          </div>
        `).join('')
      } else {
        rankBox.innerHTML = '<p class="text-xs text-slate-400 py-4 text-center">暂无班级分布数据</p>'
      }

      // 最近动态（玻璃拟态列表）
      const allExams = data.allExams || []
      const actBox = document.getElementById('recentActivityList')
      if (actBox) {
        if (allExams.length > 0) {
          actBox.innerHTML = allExams.slice(0, 8).map(e => {
            const name = e.realName || '未知考生'
            const initial = (name && name[0]) || '考'
            return `
            <div class="yx-activity-row">
              <div class="yx-activity-icon">${escapeHtml(initial)}</div>
              <div class="min-w-0">
                <div class="yx-activity-title text-truncate">${escapeHtml(name)}</div>
                <div class="yx-activity-sub text-truncate">${escapeHtml(e.className || '--')} · ${escapeHtml(e.bankTitle || '模考')}</div>
              </div>
              <span class="yx-status-pill ${e.isPassed ? 'ok' : 'bad'}">${e.isPassed ? '及格' : '未及格'}</span>
              <span class="yx-activity-meta">${formatTime(e.createdAt)}</span>
              <span class="yx-activity-amt ${e.isPassed ? 'ok' : 'bad'}">${e.score ?? 0}/${e.total ?? 100}</span>
            </div>`
          }).join('')
        } else {
          actBox.innerHTML = '<p class="text-secondary small py-4 text-center">暂无近期答卷记录</p>'
        }
      }

      // 同步右侧堆叠卡数字
      const wxStack = data.wechatOfficial
      const stackTotal = document.getElementById('wxOfficialTotalUsersStack')
      const stackSession = document.getElementById('wxOfficialSessionCntStack')
      if (wxStack && wxStack.visitTotal != null) {
        if (stackTotal) stackTotal.innerText = Number(wxStack.visitTotal || 0).toLocaleString()
        if (stackSession) stackSession.innerText = Number(wxStack.sessionCnt || 0).toLocaleString()
      }

      // 今日事件徽章色
      const todayEv = Number((data.overview || {}).todayEvents || 0)
      const todayBadge = document.getElementById('statTodayEventsBadge')
      if (todayBadge) {
        todayBadge.classList.remove('yx-badge-up', 'yx-badge-down')
        todayBadge.classList.add(todayEv > 0 ? 'yx-badge-up' : 'yx-badge-down')
      }

      renderDashboardCharts(data)
      renderCollegeQuickRail(data)
    }

    let examFlowChartInst = null
    let collegeDonutChartInst = null
    const YX_CHART_COLORS = ['#4F46E5', '#6366F1', '#818CF8', '#059669', '#D97706', '#DC2626', '#64748B', '#0F172A']

    function buildLast7DayExamCounts(exams) {
      const days = []
      const map = {}
      for (let i = 6; i >= 0; i--) {
        const d = new Date()
        d.setHours(0, 0, 0, 0)
        d.setDate(d.getDate() - i)
        const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
        const label = `${d.getMonth()+1}/${d.getDate()}`
        days.push({ key, label })
        map[key] = 0
      }
      ;(exams || []).forEach(e => {
        if (!e || !e.createdAt) return
        const d = new Date(e.createdAt)
        if (Number.isNaN(d.getTime())) return
        const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
        if (key in map) map[key] += 1
      })
      return {
        labels: days.map(d => d.label),
        values: days.map(d => map[d.key])
      }
    }

    function renderDashboardCharts(data) {
      if (typeof Chart === 'undefined') return
      const flow = buildLast7DayExamCounts(data.allExams || [])
      const barCanvas = document.getElementById('examFlowChart')
      if (barCanvas) {
        if (examFlowChartInst) examFlowChartInst.destroy()
        examFlowChartInst = new Chart(barCanvas, {
          type: 'bar',
          data: {
            labels: flow.labels,
            datasets: [{
              label: '交卷数',
              data: flow.values,
              borderRadius: 6,
              borderSkipped: false,
              backgroundColor: (ctx) => {
                const i = ctx.dataIndex
                const max = Math.max(...flow.values, 1)
                const v = flow.values[i] || 0
                return v === max && v > 0 ? '#4F46E5' : '#C7D2FE'
              },
              hoverBackgroundColor: '#4338CA'
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: '#0F172A',
                titleColor: '#fff',
                bodyColor: '#E0E7FF',
                padding: 10,
                cornerRadius: 8,
                displayColors: false,
                callbacks: {
                  label: (c) => `${c.parsed.y} 份答卷`
                }
              }
            },
            scales: {
              x: {
                grid: { display: false },
                ticks: { color: '#64748B', font: { size: 11, weight: '600' } },
                border: { display: false }
              },
              y: {
                beginAtZero: true,
                grid: { color: '#E2E8F0' },
                ticks: { color: '#64748B', precision: 0, font: { size: 11 } },
                border: { display: false }
              }
            }
          }
        })
      }

      const colleges = ((data.collegeStats || []).filter(c => c.college && c.college !== '未归属学院')).slice(0, 7)
      const donutCanvas = document.getElementById('collegeDonutChart')
      const legend = document.getElementById('collegeDonutLegend')
      const totalEl = document.getElementById('collegeDonutTotal')
      const totalStudents = colleges.reduce((s, c) => s + Number(c.studentCount || 0), 0)
      if (totalEl) totalEl.innerText = totalStudents ? totalStudents.toLocaleString() : '0'
      if (legend) {
        legend.innerHTML = colleges.length ? colleges.map((c, idx) => {
          const pct = totalStudents ? Math.round((Number(c.studentCount || 0) / totalStudents) * 100) : 0
          const color = YX_CHART_COLORS[idx % YX_CHART_COLORS.length]
          return `<div class="yx-legend-item" onclick="jumpToCollegeQuery('${escapeHtml(c.college)}')">
            <div class="yx-legend-left">
              <span class="yx-legend-bar" style="background:${color}"></span>
              <span class="yx-legend-name" title="${escapeHtml(c.college)}">${escapeHtml(c.college)}</span>
            </div>
            <span class="yx-legend-pct">${pct}%</span>
          </div>`
        }).join('') : '<div class="text-secondary small">暂无学院数据</div>'
      }
      if (donutCanvas) {
        if (collegeDonutChartInst) collegeDonutChartInst.destroy()
        collegeDonutChartInst = new Chart(donutCanvas, {
          type: 'doughnut',
          data: {
            labels: colleges.map(c => c.college),
            datasets: [{
              data: colleges.map(c => Number(c.studentCount || 0)),
              backgroundColor: colleges.map((_, i) => YX_CHART_COLORS[i % YX_CHART_COLORS.length]),
              borderWidth: 0,
              hoverOffset: 6
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '72%',
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: '#0F172A',
                titleColor: '#fff',
                bodyColor: '#E0E7FF',
                padding: 10,
                cornerRadius: 8
              }
            }
          }
        })
      }
    }

    function renderCollegeQuickRail(data) {
      const list = ((data && data.collegeStats) || []).filter(c => c.college && c.college !== '未归属学院').slice(0, 6)
      const chips = document.getElementById('collegeChipRow')
      const quick = document.getElementById('collegeQuickList')
      if (chips) {
        chips.innerHTML = list.map((c, i) => {
          const short = (c.college || '').slice(0, 1) || '院'
          return `<button type="button" class="yx-chip" title="${escapeHtml(c.college)}" onclick="jumpToCollegeQuery('${escapeHtml(c.college)}')">${escapeHtml(c.college)}</button>`
        }).join('') || ''
      }
      if (quick) {
        if (!list.length) {
          quick.innerHTML = '<div class="text-secondary small py-2">暂无学院分布</div>'
          return
        }
        quick.innerHTML = list.map((c, i) => `
          <div class="yx-sub-row" onclick="jumpToCollegeQuery('${escapeHtml(c.college)}')" style="cursor:pointer">
            <div class="yx-sub-left">
              <div class="yx-sub-ico" style="color:${YX_CHART_COLORS[i % YX_CHART_COLORS.length]}">${escapeHtml((c.college || '院')[0])}</div>
              <div class="min-w-0">
                <div class="yx-sub-name text-truncate">${escapeHtml(c.college)}</div>
                <div class="yx-sub-meta">${c.classCount || 0} 班 · 完善 ${c.completedRate || 0}%</div>
              </div>
            </div>
            <div class="yx-sub-price">${c.studentCount || 0}人</div>
          </div>
        `).join('')
      }
    }


    let currentSelectedCollege = ''

    function userCollegeOf(u) {
      return ((u && u.college) || '').trim() || '未归属学院'
    }

    function populateCollegeFilters(data) {
      const stats = (data && data.collegeStats) || []
      const opts = ['<option value="all">全部学院</option>']
        .concat(stats.map(c => `<option value="${escapeHtml(c.college)}">${escapeHtml(c.college)} (${c.studentCount}人)</option>`))
      const html = opts.join('')
      ;['userCollegeFilterSelect', 'classCollegeFilterSelect'].forEach(id => {
        const el = document.getElementById(id)
        if (!el) return
        const cur = el.value || 'all'
        el.innerHTML = html
        el.value = cur
        if (!el.value) el.value = 'all'
      })
      const collegeSelect = document.getElementById('collegeSelectDropdown')
      if (collegeSelect) {
        const cur = collegeSelect.value || ''
        let o = '<option value="">-- 浏览全部学院卡片，或在此选择 --</option>'
        stats.forEach(c => {
          o += `<option value="${escapeHtml(c.college)}">${escapeHtml(c.college)} (${c.studentCount}人 · ${c.classCount || 0}班)</option>`
        })
        collegeSelect.innerHTML = o
        if (cur) collegeSelect.value = cur
      }
      const badge = document.getElementById('collegeCountBadge')
      if (badge) badge.innerText = String(stats.length)
    }

    function renderDashboardCollegeRank(data) {
      const box = document.getElementById('dashboardCollegeRank')
      if (!box) return
      const list = (data.collegeStats || []).filter(c => c.college !== '未归属学院').slice(0, 9)
      if (!list.length) {
        box.innerHTML = '<p class="text-slate-400 py-4 text-center col-span-full">暂无学院分布（完善班级后将自动归属）</p>'
        return
      }
      box.innerHTML = list.map((c, idx) => `
        <div onclick="jumpToCollegeQuery('${escapeHtml(c.college)}')" class="college-card flex items-center justify-between py-2 px-3 rounded-xl border border-slate-100 bg-slate-50/80 hover:border-indigo-200">
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-5 h-5 rounded-full ${idx < 3 ? 'bg-violet-100 text-violet-700 font-bold' : 'bg-slate-100 text-slate-500'} flex items-center justify-center text-[10px]">${idx + 1}</span>
            <span class="font-medium text-slate-800 truncate">${escapeHtml(c.college)}</span>
          </div>
          <span class="text-slate-500 font-semibold whitespace-nowrap ml-2">${c.studentCount}人</span>
        </div>
      `).join('')
    }

    function renderCollegeCards() {
      if (!globalStats) return
      const q = ((document.getElementById('collegeSearchInput') || {}).value || '').trim().toLowerCase()
      let list = globalStats.collegeStats || []
      if (q) list = list.filter(c => (c.college || '').toLowerCase().includes(q))
      const grid = document.getElementById('collegeCardsGrid')
      if (!grid) return
      if (!list.length) {
        grid.innerHTML = '<div class="col-span-full text-center text-slate-400 text-xs py-10">没有匹配的学院</div>'
        return
      }
      grid.innerHTML = list.map(c => {
        const short = (c.college || '').length > 18 ? (c.college.slice(0, 18) + '…') : c.college
        return `
        <div class="college-card bg-white rounded-2xl border border-slate-200 p-4 shadow-sm" onclick="jumpToCollegeQuery('${escapeHtml(c.college)}')">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="text-sm font-bold text-slate-900 leading-snug" title="${escapeHtml(c.college)}">${escapeHtml(short)}</div>
              <div class="text-[11px] text-slate-400 mt-1">${c.classCount || 0} 个班级</div>
            </div>
            <span class="text-[10px] px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-100 font-semibold">学院</span>
          </div>
          <div class="grid grid-cols-3 gap-2 mt-3 text-center">
            <div class="bg-slate-50 rounded-lg py-2"><div class="text-[10px] text-slate-400">学生</div><div class="font-bold text-slate-800">${c.studentCount}</div></div>
            <div class="bg-slate-50 rounded-lg py-2"><div class="text-[10px] text-slate-400">完善率</div><div class="font-bold text-emerald-600">${c.completedRate || 0}%</div></div>
            <div class="bg-slate-50 rounded-lg py-2"><div class="text-[10px] text-slate-400">均分</div><div class="font-bold text-indigo-600">${c.avgScore || 0}</div></div>
          </div>
        </div>`
      }).join('')
    }

    function jumpToCollegeQuery(college) {
      switchTab('colleges')
      const sel = document.getElementById('collegeSelectDropdown')
      if (sel) sel.value = college
      currentSelectedCollege = college
      renderCurrentCollegeDetails(college)
    }

    function onSelectCollegeChange() {
      const sel = document.getElementById('collegeSelectDropdown')
      const college = (sel && sel.value) || ''
      currentSelectedCollege = college
      if (college) renderCurrentCollegeDetails(college)
      else {
        document.getElementById('collegeOverviewCard').classList.add('hidden')
        document.getElementById('collegeStudentsPanel').classList.add('hidden')
        document.getElementById('collegeExportBtn').classList.add('hidden')
      }
    }

    function renderCurrentCollegeDetails(college) {
      if (!college || !globalStats) return
      const cStat = ((globalStats.collegeStats || []).find(c => c.college === college)) || {}
      const users = (globalStats.users || []).filter(u => userCollegeOf(u) === college)
      document.getElementById('collegeOverviewCard').classList.remove('hidden')
      document.getElementById('collegeStudentsPanel').classList.remove('hidden')
      document.getElementById('collegeExportBtn').classList.remove('hidden')
      document.getElementById('activeCollegeName').innerText = college
      document.getElementById('activeCollegeTotal').innerText = users.length
      document.getElementById('activeCollegeClasses').innerText = cStat.classCount || 0
      document.getElementById('activeCollegeCompleted').innerText = users.filter(u => u.isProfileCompleted).length
      document.getElementById('activeCollegeRate').innerText = `${cStat.completedRate || 0}%`
      document.getElementById('activeCollegeAvgScore').innerText = `${cStat.avgScore || 0}`
      document.getElementById('activeCollegeMaxScore').innerText = `${cStat.maxScore || 0}`
      document.getElementById('collegeTableCountText').innerText = `本院共 ${users.length} 人`
      const search = document.getElementById('collegeStudentSearchInput')
      if (search) search.value = ''
      renderCollegeStudentsTable(users)
    }

    function renderCollegeStudentsTable(students) {
      const tbody = document.getElementById('collegeStudentsTableBody')
      if (!tbody) return
      if (!students || !students.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="py-8 text-center text-slate-400">本院暂无匹配学生</td></tr>'
        return
      }
      tbody.innerHTML = students.map((u, idx) => `
        <tr class="hover:bg-slate-50 transition">
          <td class="py-3 px-4 font-mono text-slate-400">${idx + 1}</td>
          <td class="py-3 px-4 font-semibold text-slate-900">${escapeHtml(u.realName || u.nickname || '未登记')}</td>
          <td class="py-3 px-4"><span onclick="jumpToClassQuery('${escapeHtml(u.className || '')}')" class="text-indigo-600 hover:underline cursor-pointer">${escapeHtml(u.className || '--')}</span></td>
          <td class="py-3 px-4 font-mono">${escapeHtml(u.displayPhone || u.phone || '--')}</td>
          <td class="py-3 px-4 font-mono text-slate-500">${escapeHtml(u.studentId || '--')}</td>
          <td class="py-3 px-4">${u.examCount || 0}</td>
          <td class="py-3 px-4 font-bold ${u.maxScore >= 60 ? 'text-emerald-600' : 'text-slate-600'}">${u.maxScore || 0}</td>
          <td class="py-3 px-4"><span class="px-2 py-0.5 rounded-full text-[10px] font-semibold ${u.isProfileCompleted ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500'}">${u.isProfileCompleted ? '已完善' : '待完善'}</span></td>
          <td class="py-3 px-4 text-right"><button type="button" onclick="showUserDetailModal('${u.id}')" class="yx-row-btn">详情</button></td>
        </tr>
      `).join('')
    }

    function filterCurrentCollegeStudents() {
      if (!currentSelectedCollege || !globalStats) return
      const keyword = ((document.getElementById('collegeStudentSearchInput') || {}).value || '').trim().toLowerCase()
      let users = (globalStats.users || []).filter(u => userCollegeOf(u) === currentSelectedCollege)
      if (keyword) {
        users = users.filter(u =>
          (u.realName && u.realName.toLowerCase().includes(keyword)) ||
          (u.className && u.className.toLowerCase().includes(keyword)) ||
          (u.phone && String(u.phone).includes(keyword)) ||
          (u.studentId && String(u.studentId).includes(keyword))
        )
      }
      renderCollegeStudentsTable(users)
    }

    function exportCurrentCollegeCsv() {
      if (!currentSelectedCollege) return
      const url = `/api/admin/export/users.csv?college=${encodeURIComponent(currentSelectedCollege)}&token=${encodeURIComponent(getAdminToken())}`
      window.open(url, '_blank')
    }

    function onClassCollegeFilterChange() {
      populateClassSelectOptions(globalStats || {})
      const sel = document.getElementById('classSelectDropdown')
      if (sel) { sel.value = ''; onSelectClassChange() }
    }

    // 填充班级下拉选项
    function populateClassSelectOptions(data) {
      const select = document.getElementById('classSelectDropdown')
      if (!select) return
      const currentVal = select.value
      let classList = (data && data.classStats) || []
      const collegeFilterEl = document.getElementById('classCollegeFilterSelect')
      const collegeFilter = collegeFilterEl ? collegeFilterEl.value : 'all'
      if (collegeFilter && collegeFilter !== 'all' && data && data.users) {
        const allowed = new Set(
          (data.users || [])
            .filter(u => userCollegeOf(u) === collegeFilter)
            .map(u => (u.className || '').trim())
            .filter(Boolean)
        )
        classList = classList.filter(c => allowed.has((c.className || '').trim()))
      }
      let optionsHtml = '<option value="">-- 请选择需要查询的班级 (共 ' + classList.length + ' 个班级) --</option>'
      classList.forEach(c => {
        optionsHtml += `<option value="${escapeHtml(c.className)}">${escapeHtml(c.className)} (${c.studentCount}人 · 档案完善率 ${c.completedRate || 0}%)</option>`
      })
      select.innerHTML = optionsHtml
      if (currentVal) select.value = currentVal
    }

    // 点击大屏的班级直接跳转并选中该班
    function jumpToClassQuery(className) {
      switchTab('classes')
      const select = document.getElementById('classSelectDropdown')
      select.value = className
      onSelectClassChange()
    }

    // 下拉选择班级触发
    function onSelectClassChange() {
      const select = document.getElementById('classSelectDropdown')
      const selectedClass = select.value
      currentSelectedClass = selectedClass
      document.getElementById('classStudentSearchInput').value = ''
      renderCurrentClassDetails(selectedClass)
    }

    // 渲染指定班级的详细卡片与学生名单
    function renderCurrentClassDetails(className) {
      const overviewCard = document.getElementById('classOverviewCard')
      const exportBtnWrapper = document.getElementById('classExportBtnWrapper')
      const tbody = document.getElementById('classStudentsTableBody')
      const countText = document.getElementById('classTableCountText')

      if (!className) {
        overviewCard.classList.add('hidden')
        exportBtnWrapper.classList.add('hidden')
        countText.innerText = '请先在上方选择班级'
        tbody.innerHTML = '<tr><td colspan="9" class="yx-empty">先在上方选择学院和班级，名册会出现在这里。</td></tr>'
        return
      }

      overviewCard.classList.remove('hidden')
      exportBtnWrapper.classList.remove('hidden')

      // 获取该班统计
      const classStats = (globalStats && globalStats.classStats) || []
      const cStat = classStats.find(c => c.className === className) || {}

      // 获取该班所有学生
      const allUsers = (globalStats && globalStats.users) || []
      const classUsers = allUsers.filter(u => (u.className || '').trim() === className.trim())

      // 班级卡片赋值
      document.getElementById('activeClassName').innerText = className
      document.getElementById('activeClassTotal').innerText = classUsers.length
      const completedCount = classUsers.filter(u => u.isProfileCompleted).length
      document.getElementById('activeClassCompleted').innerText = completedCount
      const rate = classUsers.length > 0 ? Math.round((completedCount / classUsers.length) * 100) : 0
      document.getElementById('activeClassRate').innerText = `${rate}%`
      document.getElementById('activeClassAvgScore').innerText = `${cStat.avgScore || 0} 分`
      document.getElementById('activeClassMaxScore').innerText = `${cStat.maxScore || 0} 分`

      // 渲染表格
      countText.innerText = `当前班级共 ${classUsers.length} 位同学`
      renderClassStudentsTable(classUsers)
    }

    // 渲染该班级成员表格
    function renderClassStudentsTable(students) {
      const tbody = document.getElementById('classStudentsTableBody')
      if (!students || students.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="py-8 text-center text-slate-400">该班暂无匹配学生</td></tr>'
        return
      }

      tbody.innerHTML = students.map((u, idx) => `
        <tr class="hover:bg-slate-50 transition">
          <td class="py-3 px-4 font-mono text-slate-400">${idx + 1}</td>
          <td class="py-3 px-4 font-semibold text-slate-900">
            <div class="flex items-center space-x-2">
              <div class="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
                ${escapeHtml((u.realName && u.realName[0]) || (u.nickname && u.nickname[0]) || '考')}
              </div>
              <span>${escapeHtml(u.realName || u.nickname || '未登记姓名')}</span>
            </div>
          </td>
          <td class="py-3 px-4 font-mono font-semibold text-slate-700">${escapeHtml(u.displayPhone || u.phone || '--')}</td>
          <td class="py-3 px-4 font-mono text-slate-600">${escapeHtml(u.studentId || '--')}</td>
          <td class="py-3 px-4 font-semibold">${u.examCount || 0} 次</td>
          <td class="py-3 px-4 font-bold ${u.maxScore >= 60 ? 'text-emerald-600' : 'text-slate-600'}">${u.maxScore || 0} 分</td>
          <td class="py-3 px-4">${u.avgAccuracy ? u.avgAccuracy + '%' : '--'}</td>
          <td class="py-3 px-4">
            <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold ${u.isProfileCompleted ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500'}">
              ${u.isProfileCompleted ? '已完善' : '待完善'}
            </span>
          </td>
          <td class="py-3 px-4 text-right">
            <button type="button" onclick="showUserDetailModal('${u.id}')" class="yx-row-btn">查看档案</button>
          </td>
        </tr>
      `).join('')
    }

    // 在当前班级内二次打字搜索
    function filterCurrentClassStudents() {
      if (!currentSelectedClass || !globalStats || !globalStats.users) return
      const keyword = (document.getElementById('classStudentSearchInput').value || '').trim().toLowerCase()
      const classUsers = globalStats.users.filter(u => (u.className || '').trim() === currentSelectedClass.trim())

      if (!keyword) {
        renderClassStudentsTable(classUsers)
        return
      }

      const filtered = classUsers.filter(u => 
        (u.realName && u.realName.toLowerCase().includes(keyword)) ||
        (u.phone && u.phone.includes(keyword)) ||
        (u.studentId && u.studentId.includes(keyword))
      )
      renderClassStudentsTable(filtered)
    }

    // 一键导出当前选中班级学生名单 CSV
    function exportCurrentClassCsv() {
      if (!currentSelectedClass) return
      const url = `/api/admin/export/users.csv?className=${encodeURIComponent(currentSelectedClass)}&token=${encodeURIComponent(getAdminToken())}`
      window.open(url, '_blank')
    }

    // 渲染全校考生名册表格
    function renderUsersTable(users) {
      const tbody = document.getElementById('usersTableBody')
      if (!users || users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="yx-empty">没有符合条件的考生。<button type="button" class="btn btn-ghost" onclick="clearUserFilters()">清除筛选</button></td></tr>'
        return
      }

      tbody.innerHTML = users.map(u => `
        <tr class="hover:bg-slate-50 transition">
          <td class="py-3 px-4 font-semibold text-slate-900">
            <div class="flex items-center space-x-2">
              <div class="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
                ${escapeHtml((u.realName && u.realName[0]) || (u.nickname && u.nickname[0]) || '考')}
              </div>
              <span>${escapeHtml(u.realName || u.nickname || '未登记')}</span>
            </div>
          </td>
          <td class="py-3 px-4">
            <span onclick="jumpToCollegeQuery('${escapeHtml(userCollegeOf(u))}')" class="text-violet-700 hover:underline cursor-pointer font-medium" title="${escapeHtml(userCollegeOf(u))}">${escapeHtml((userCollegeOf(u).length > 10 ? userCollegeOf(u).slice(0,10)+'\u2026' : userCollegeOf(u)))}</span>
          </td>
          <td class="py-3 px-4">
            <span onclick="jumpToClassQuery('${escapeHtml(u.className || '')}')" class="text-indigo-600 hover:underline cursor-pointer font-medium">${escapeHtml(u.className || '--')}</span>
          </td>
          <td class="py-3 px-4 font-mono text-slate-600">${escapeHtml(u.displayPhone || u.phone || '--')}</td>
          <td class="py-3 px-4 font-mono text-slate-500">${escapeHtml(u.studentId || '--')}</td>
          <td class="py-3 px-4 font-semibold">${u.examCount || 0} 次</td>
          <td class="py-3 px-4 font-bold ${u.maxScore >= 60 ? 'text-emerald-600' : 'text-slate-600'}">${u.maxScore || 0}</td>
          <td class="py-3 px-4">
            <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold ${u.isProfileCompleted ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500'}">
              ${u.isProfileCompleted ? '已完善' : '未完善'}
            </span>
          </td>
          <td class="py-3 px-4 text-slate-400 text-[11px]">${formatTime(u.lastLoginAt || u.createdAt)}</td>
          <td class="py-3 px-4 text-right">
            <button type="button" onclick="showUserDetailModal('${u.id}')" class="yx-row-btn">详情</button>
          </td>
        </tr>
      `).join('')
    }

    // 搜索全校考生
    function handleUserSearch() {
      if (!globalStats || !globalStats.users) return
      const keyword = (document.getElementById('userSearchInput').value || '').trim().toLowerCase()
      const filter = document.getElementById('userFilterSelect').value
      const collegeEl = document.getElementById('userCollegeFilterSelect')
      const collegeFilter = collegeEl ? collegeEl.value : 'all'
      let filtered = globalStats.users
      if (filter === 'done' || filter === 'completed') filtered = filtered.filter(u => u.isProfileCompleted)
      if (filter === 'todo' || filter === 'pending') filtered = filtered.filter(u => !u.isProfileCompleted)
      if (collegeFilter && collegeFilter !== 'all') {
        filtered = filtered.filter(u => userCollegeOf(u) === collegeFilter)
      }
      if (keyword) {
        filtered = filtered.filter(u =>
          (u.realName && u.realName.toLowerCase().includes(keyword)) ||
          (u.className && u.className.toLowerCase().includes(keyword)) ||
          (u.college && u.college.toLowerCase().includes(keyword)) ||
          (u.phone && String(u.phone).includes(keyword)) ||
          (u.studentId && String(u.studentId).includes(keyword))
        )
      }
      renderUsersTable(filtered)
    }

    // 渲染考试记录
    function renderExamsTable(exams) {
      const tbody = document.getElementById('examsTableBody')
      if (!exams || exams.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="yx-empty">没有符合条件的模考记录。<button type="button" class="btn btn-ghost" onclick="clearExamFilters()">清除筛选</button></td></tr>'
        return
      }

      tbody.innerHTML = exams.map(e => `
        <tr class="hover:bg-slate-50 transition">
          <td class="py-3 px-4 text-slate-500">${formatTime(e.createdAt)}</td>
          <td class="py-3 px-4 font-semibold text-slate-900">${escapeHtml(e.realName || '--')}</td>
          <td class="py-3 px-4 text-slate-600">${escapeHtml(e.className || '--')}</td>
          <td class="py-3 px-4 font-mono text-slate-500">${escapeHtml(e.phone || '--')}</td>
          <td class="py-3 px-4">${escapeHtml(e.bankTitle || '默认题库')}</td>
          <td class="py-3 px-4 font-bold text-slate-900">${e.score ?? 0} / ${e.total ?? 100}</td>
          <td class="py-3 px-4 font-semibold ${e.accuracy >= 60 ? 'text-emerald-600' : 'text-rose-600'}">${e.accuracy ?? 0}%</td>
          <td class="py-3 px-4">
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${e.isPassed ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}">
              ${e.isPassed ? '及格' : '不及格'}
            </span>
          </td>
        </tr>
      `).join('')
    }

    // 公告数据加载与实时预览
    async function loadAnnouncementData() {
      try {
        const res = await adminFetch('/api/announcement/admin?token=' + encodeURIComponent(getAdminToken()))
        const json = await res.json()
        if (json.code === 0 && json.data) {
          const cfg = json.data.config || json.data
          document.getElementById('annEnabled').checked = Boolean(cfg.enabled)
          document.getElementById('annTitle').value = cfg.title || ''
          document.getElementById('annText').value = cfg.text || ''
          document.getElementById('annContact').value = cfg.contactValue || ''
          document.getElementById('annShowMode').value = cfg.showMode || 'always'
          document.getElementById('annImage').value = cfg.image || ''
          updateAnnouncementPreview()
        }
      } catch (err) {
        console.warn('拉取公告失败:', err)
        const fail = document.getElementById('annLoadError')
        if (fail) fail.classList.remove('hidden')
      }
    }

    function updateAnnouncementPreview() {
      const enabled = document.getElementById('annEnabled').checked
      const title = (document.getElementById('annTitle').value || '').trim()
      const text = (document.getElementById('annText').value || '').trim()
      const contact = (document.getElementById('annContact').value || '').trim()
      const img = (document.getElementById('annImage').value || '').trim()
      const empty = !title && !text && !contact && !img
      const emptyEl = document.getElementById('prevEmpty')
      const bodyEl = document.getElementById('prevBody')
      if (emptyEl) emptyEl.classList.toggle('hidden', !empty)
      if (bodyEl) bodyEl.classList.toggle('hidden', empty)
      const titleEl = document.getElementById('prevTitle')
      const textEl = document.getElementById('prevText')
      const contactEl = document.getElementById('prevContact')
      if (titleEl) titleEl.innerText = title || '公告'
      if (textEl) textEl.innerText = text
      if (contactEl) contactEl.innerText = contact
      const imgEl = document.getElementById('prevImg')
      if (imgEl) {
        if (img) {
          imgEl.src = img
          imgEl.classList.remove('hidden', 'd-none')
          imgEl.style.display = 'block'
        } else {
          imgEl.classList.add('hidden')
          imgEl.style.display = 'none'
        }
      }
      const note = document.getElementById('prevEnabledNote')
      if (note) note.textContent = enabled ? '已启用：按上方展示模式向小程序弹出。' : '未启用：保存后小程序不会弹出此公告。'
    }

    async function saveAnnouncementConfig() {
      const btn = document.getElementById('btnSaveAnn')
      btn.disabled = true
        btn.innerText = '正在同步…'
      try {
        const payload = {
          enabled: document.getElementById('annEnabled').checked,
          title: document.getElementById('annTitle').value,
          text: document.getElementById('annText').value,
          contactValue: document.getElementById('annContact').value,
          showMode: document.getElementById('annShowMode').value,
          image: document.getElementById('annImage').value,
        }
        const res = await adminFetch('/api/announcement/admin?token=' + encodeURIComponent(getAdminToken()), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        const json = await res.json()
        if (json.code === 0) {
          showToast('公告已保存并实时同步给全体小程序用户！', 'success')
        } else {
          showToast(json.message || '保存失败', 'error')
        }
      } catch (e) {
        showToast('保存异常: ' + e.message, 'error')
      } finally {
        btn.disabled = false
        btn.innerText = '保存并同步'
      }
    }

    // 上课提醒与电费预警配置数据
    async function loadReminderData() {
      try {
        const res = await adminFetch('/api/reminder/admin')
        const json = await res.json()
        if (json.code === 0 && json.data) {
          const cfg = json.data.config || {}
          const tplEl = document.getElementById('remindTemplateId')
          const elecEl = document.getElementById('electricityTemplateId')
          const finEl = document.getElementById('financeJsessionId')
          const aheadEl = document.getElementById('remindAheadMinutes')
          if (tplEl && cfg.templateId) tplEl.value = cfg.templateId
          if (elecEl && cfg.electricityTemplateId) elecEl.value = cfg.electricityTemplateId
          if (finEl && cfg.financeJsessionId) finEl.value = cfg.financeJsessionId
          if (aheadEl && cfg.defaultAheadMinutes) aheadEl.value = cfg.defaultAheadMinutes
          renderReminderLogs(json.data.logs || [])
        }
      } catch (e) {
        console.warn('读取提醒配置失败:', e)
        const tbody = document.getElementById('reminderLogsBody')
        if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="yx-empty">下发日志没有加载成功。<button type="button" class="btn btn-ghost" onclick="loadReminderData()">重试</button></td></tr>'
      }
    }
    function renderReminderLogs(logs) {
      const tbody = document.getElementById('reminderLogsBody')
      if (!tbody) return
      if (!logs || !logs.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="yx-empty">暂无下发日志。同学开启上课提醒并成功下发后，记录会出现在这里。</td></tr>'
        return
      }
      const label = { sent: '已发送', failed: '失败', skipped: '跳过' }
      tbody.innerHTML = logs.map((l) => `
        <tr>
          <td>${formatTime(l.createdAt)}</td>
          <td>${escapeHtml(l.className || '—')}</td>
          <td>${escapeHtml(l.courseName || '—')}</td>
          <td>${l.startAt ? formatTime(l.startAt) : '—'}</td>
          <td><span class="yx-status-pill ${l.status === 'sent' ? 'ok' : 'bad'}">${escapeHtml(label[l.status] || l.status || '—')}</span></td>
        </tr>
      `).join('')
    }
    async function saveReminderConfig() {
      try {
        const templateId = (document.getElementById('remindTemplateId')?.value || '').trim()
        const electricityTemplateId = (document.getElementById('electricityTemplateId')?.value || '').trim()
        const financeJsessionId = (document.getElementById('financeJsessionId')?.value || '').trim()
        const defaultAheadMinutes = parseInt(document.getElementById('remindAheadMinutes')?.value || '20', 10) || 20
        const res = await adminFetch('/api/reminder/admin', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ templateId, electricityTemplateId, financeJsessionId, defaultAheadMinutes })
        })
        const json = await res.json()
        if (json.code === 0) {
          showToast('提醒与低电费预警配置已保存！', 'success')
        } else {
          showToast(json.message || '保存失败', 'error')
        }
      } catch (e) {
        showToast('保存异常: ' + e.message, 'error')
      }
    }

    // 手动一键拉取线上真实考生数据
    async function syncFromCloudBaseAction() {
      const btns = [document.getElementById('btnSyncCloud'), document.getElementById('btnSyncCloudRail')].filter(Boolean)
      btns.forEach(btn => { btn.disabled = true; btn.innerText = '正在同步中...' })
      showToast('正在从云端拉取真实考生档案与成绩...', 'info')
      try {
        const res = await adminFetch('/api/admin/sync-cloud', { method: 'POST' })
        const json = await res.json()
        if (json.code === 0) {
          showToast(json.message || '同步完成', 'success')
          loadAllData()
        } else {
          showToast(json.message || '同步失败', 'error')
        }
      } catch (e) {
        showToast('网络同步异常: ' + e.message, 'error')
      } finally {
        const label = '<i class="ti ti-cloud-download" aria-hidden="true"></i><span class="yx-btn-label">从云托管同步</span>'
        btns.forEach(btn => { btn.disabled = false; btn.innerHTML = label })
      }
    }

    function escapeHtml(str) {
      if (!str) return ''
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    }

    function formatTime(ts) {
      if (!ts) return '--'
      const d = new Date(ts)
      return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
    }

    function showToast(msg, type = 'success') {
      const el = document.getElementById('toast')
      if (!el) return
      document.getElementById('toastMsg').innerText = msg
      const icon = document.getElementById('toastIcon')
      if (icon) icon.innerHTML = type === 'error'
        ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>'
      el.classList.remove('toast-success', 'toast-error', 'toast-info')
      el.classList.add(type === 'error' ? 'toast-error' : (type === 'success' ? 'toast-success' : 'toast-info'))
      el.classList.add('show')
      el.classList.remove('translate-y-20', 'opacity-0')
      clearTimeout(window.__yxToastTimer)
      window.__yxToastTimer = setTimeout(() => {
        el.classList.remove('show')
        el.classList.add('translate-y-20', 'opacity-0')
      }, 3000)
    }

    let examStatusFilter = 'all'

    function setUserStatusFilter(value, btn) {
      const sel = document.getElementById('userFilterSelect')
      if (sel) sel.value = value
      if (btn && btn.parentElement) {
        btn.parentElement.querySelectorAll('.yx-filter-chip').forEach((el) => el.classList.remove('is-on'))
        btn.classList.add('is-on')
      }
      handleUserSearch()
    }

    function clearUserFilters() {
      const search = document.getElementById('userSearchInput')
      const sel = document.getElementById('userFilterSelect')
      const college = document.getElementById('userCollegeFilterSelect')
      if (search) search.value = ''
      if (sel) sel.value = 'all'
      if (college) college.value = 'all'
      document.querySelectorAll('#userFilterChips .yx-filter-chip').forEach((el, i) => el.classList.toggle('is-on', i === 0))
      handleUserSearch()
    }

    function setExamStatusFilter(value, btn) {
      examStatusFilter = value
      if (btn && btn.parentElement) {
        btn.parentElement.querySelectorAll('.yx-filter-chip').forEach((el) => el.classList.remove('is-on'))
        btn.classList.add('is-on')
      }
      handleExamSearch()
    }

    function handleExamSearch() {
      if (!globalStats) return
      const input = document.getElementById('examSearchInput')
      const keyword = ((input && input.value) || '').trim().toLowerCase()
      let rows = globalStats.allExams || []
      if (examStatusFilter === 'pass') rows = rows.filter((e) => e.isPassed)
      if (examStatusFilter === 'fail') rows = rows.filter((e) => !e.isPassed)
      if (keyword) {
        rows = rows.filter((e) =>
          (e.realName && String(e.realName).toLowerCase().includes(keyword)) ||
          (e.className && String(e.className).toLowerCase().includes(keyword)) ||
          (e.bankTitle && String(e.bankTitle).toLowerCase().includes(keyword)) ||
          (e.phone && String(e.phone).includes(keyword))
        )
      }
      renderExamsTable(rows)
    }

    function clearExamFilters() {
      examStatusFilter = 'all'
      const input = document.getElementById('examSearchInput')
      if (input) input.value = ''
      document.querySelectorAll('#examFilterChips .yx-filter-chip').forEach((el, i) => el.classList.toggle('is-on', i === 0))
      handleExamSearch()
    }

    function clearCollegeFilters() {
      const search = document.getElementById('collegeSearchInput')
      const sel = document.getElementById('collegeSelectDropdown')
      if (search) search.value = ''
      if (sel) sel.value = ''
      renderCollegeCards()
      onSelectCollegeChange()
    }

    function clearClassFilters() {
      const college = document.getElementById('classCollegeFilterSelect')
      const search = document.getElementById('classStudentSearchInput')
      if (college) college.value = 'all'
      if (search) search.value = ''
      onClassCollegeFilterChange()
    }

    function showUserDetailModal(userId) {
      if (!globalStats || !globalStats.users) return
      const user = globalStats.users.find(u => u.id === userId)
      if (!user) return
      alert(`【考生详情档案】\n真实姓名: ${user.realName || '--'}\n所在班级: ${user.className || '--'}\n电话号码: ${user.phone || '--'}\n学号: ${user.studentId || '--'}\n累计登录: ${user.loginCount || 1} 次\n已考次数: ${user.examCount || 0} 次\n最高得分: ${user.maxScore || 0} 分`)
    }
  
    // 导出给 HTML onclick / 调试
    window.handleAuthSubmit = handleAuthSubmit
    window.adminLogout = adminLogout
    window.showAuthModal = showAuthModal
    window.hideAuthModal = hideAuthModal
    window.togglePasswordVisibility = togglePasswordVisibility
    window.renderDashboardCharts = renderDashboardCharts
    window.renderCollegeQuickRail = renderCollegeQuickRail
    window.syncFromCloudBaseAction = syncFromCloudBaseAction
    window.switchTab = switchTab
    window.refreshCurrentTab = refreshCurrentTab
    window.exportUsersCsv = exportUsersCsv
    window.exportExamsCsv = exportExamsCsv
    window.setUserStatusFilter = setUserStatusFilter
    window.clearUserFilters = clearUserFilters
    window.setExamStatusFilter = setExamStatusFilter
    window.handleExamSearch = handleExamSearch
    window.clearExamFilters = clearExamFilters
    window.clearCollegeFilters = clearCollegeFilters
    window.clearClassFilters = clearClassFilters
    window.loadAnnouncementData = loadAnnouncementData
    window.loadReminderData = loadReminderData
    window.showUserDetailModal = showUserDetailModal
