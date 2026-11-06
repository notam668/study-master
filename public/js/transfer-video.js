/**
 * 转专业视频 · 后台管理（ycgxy.xyz）
 * 依赖 index.html 中已登录的 admin token（localStorage/sessionStorage 键 yanxiaogong_admin_token）
 * 视频/海报直传桥机 media.ycgxy.xyz；元数据写云托管 /api/admin/transfer/*
 */
;(function () {
  'use strict'

  // 部署时替换为真实域名（占位符，不含密钥）
  var BRIDGE_BASE = 'https://media.ycgxy.xyz' // 例：https://media.ycgxy.xyz
  var API_BASE = '' // 同源：https://www.ycgxy.xyz
  var MAX_VIDEO_MB = 50
  var MAX_POSTER_MB = 2

  function token() {
    return (
      localStorage.getItem('yanxiaogong_admin_token') ||
      sessionStorage.getItem('yanxiaogong_admin_token') ||
      ''
    )
  }

  function $(id) {
    return document.getElementById(id)
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  function msg(text, isError) {
    var el = $('tvUploadMsg')
    if (!el) return
    el.textContent = text || ''
    el.className = 'yx-banner' + (isError ? ' yx-banner-error' : '') + (text ? '' : ' hidden')
    el.style.display = text ? 'block' : 'none'
  }

  function api(path, options) {
    var opts = options || {}
    var headers = Object.assign({}, opts.headers || {})
    var t = token()
    if (t) headers['x-admin-token'] = t
    return fetch(API_BASE + path, Object.assign({}, opts, { headers: headers })).then(function (res) {
      return res.json().catch(function () {
        return { code: res.status, message: 'HTTP ' + res.status }
      })
    })
  }

  function fmtDuration(sec) {
    var s = Math.max(0, Number(sec) || 0)
    var mm = String(Math.floor(s / 60)).padStart(2, '0')
    var ss = String(s % 60).padStart(2, '0')
    return mm + ':' + ss
  }

  function fileNameOf(url) {
    try {
      var clean = String(url || '').split('?')[0]
      return clean.substring(clean.lastIndexOf('/') + 1)
    } catch (e) {
      return ''
    }
  }

  var videoUrlById = {}

  function render(videos) {
    var body = $('tvTableBody')
    if (!body) return
    videoUrlById = {}
    if (!videos || !videos.length) {
      body.innerHTML = '<tr><td colspan="6" class="yx-empty">还没有视频。左侧上传一个 mp4 后点「上架」。</td></tr>'
      return
    }
    videos.forEach(function (v) { videoUrlById[String(v.id)] = v.url })
    body.innerHTML = videos
      .map(function (v) {
        var on = Number(v.status) === 1
        var badge = on
          ? '<span class="badge bg-green-lt">已上架</span>'
          : '<span class="badge bg-red-lt">已下架</span>'
        var btn = on
          ? '<button type="button" class="btn btn-ghost btn-sm" onclick="transferVideoSetStatus(' + v.id + ',0)">下架</button>'
          : '<button type="button" class="btn btn-primary btn-sm" onclick="transferVideoSetStatus(' + v.id + ',1)">上架</button>'
        return (
          '<tr><td>' + esc(v.id) + '</td>' +
          '<td class="yx-sticky-id"><div class="fw-semibold">' + esc(v.title) + '</div>' +
          '<div class="text-secondary small text-break">' + esc(v.url) + '</div></td>' +
          '<td>' + fmtDuration(v.duration_sec) + '</td>' +
          '<td>' + badge + '</td>' +
          '<td class="text-secondary small">' + esc(v.updated_at || '') + '</td>' +
          '<td class="yx-sticky-ops">' + btn + '</td></tr>'
        )
      })
      .join('')
  }

  function loadTransferVideoData() {
    if (!token()) {
      msg('请先在上方输入管理员密码进入后台，再管理视频。', true)
      return Promise.resolve()
    }
    var body = $('tvTableBody')
    if (body) body.innerHTML = '<tr><td colspan="6" class="yx-empty">加载中…</td></tr>'
    return api('/api/admin/transfer/videos', { method: 'GET' })
      .then(function (json) {
        if (!json || json.code !== 0) throw new Error((json && json.message) || '读取失败')
        render(json.data && json.data.videos)
      })
      .catch(function (e) {
        if (body) body.innerHTML = '<tr><td colspan="6" class="yx-empty">加载失败：' + esc(e.message) + '</td></tr>'
      })
  }

  function uploadFile(url, field, file, kind) {
    var fd = new FormData()
    fd.append(field, file, file.name)
    return fetch(BRIDGE_BASE + url, {
      method: 'POST',
      headers: { 'x-admin-token': token() },
      body: fd,
    }).then(function (res) {
      return res.json().catch(function () {
        return { ok: false, error: 'HTTP ' + res.status }
      }).then(function (json) {
        if (!json || !json.ok) throw new Error((json && json.error) || kind + ' 上传失败')
        return json
      })
    })
  }

  function uploadTransferVideo() {
    var fileEl = $('tvFile')
    var titleEl = $('tvTitle')
    var durEl = $('tvDuration')
    var sortEl = $('tvSort')
    var posterEl = $('tvPoster')
    var btn = $('tvUploadBtn')
    var file = fileEl && fileEl.files && fileEl.files[0]
    var title = String((titleEl && titleEl.value) || '').trim()
    if (!token()) return msg('请先登录后台再上传。', true)
    if (!file) return msg('请选择 mp4 视频文件。', true)
    if (!/\.mp4$/i.test(file.name) && file.type !== 'video/mp4') return msg('只支持 mp4。', true)
    if (file.size > MAX_VIDEO_MB * 1024 * 1024) return msg('视频超过 ' + MAX_VIDEO_MB + 'MB。', true)
    if (!title) return msg('请填写标题。', true)
    var poster = posterEl && posterEl.files && posterEl.files[0]
    if (poster && poster.size > MAX_POSTER_MB * 1024 * 1024) return msg('海报超过 ' + MAX_POSTER_MB + 'MB。', true)

    if (btn) { btn.disabled = true; btn.textContent = '上传中…' }
    msg('正在上传视频到媒体服务器…', false)

    var posterUrl = ''
    var p = Promise.resolve()
    if (poster) {
      p = uploadFile('/admin/poster', 'file', poster, '海报').then(function (r) {
        posterUrl = r.url
      })
    }
    p.then(function () {
      return uploadFile('/admin/upload', 'file', file, '视频')
    })
      .then(function (up) {
        return api('/api/admin/transfer/video', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: title,
            url: up.url,
            poster_url: posterUrl,
            duration_sec: Math.max(1, Number(durEl && durEl.value) || 5),
            sort: Number(sortEl && sortEl.value) || 0,
            status: 0,
          }),
        })
      })
      .then(function (json) {
        if (!json || json.code !== 0) throw new Error((json && json.message) || '元数据保存失败')
        msg('已上传并保存（默认下架）。请在右侧列表点「上架」。', false)
        if (fileEl) fileEl.value = ''
        if (posterEl) posterEl.value = ''
        return loadTransferVideoData()
      })
      .catch(function (e) {
        msg('失败：' + e.message, true)
      })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = '上传并保存（默认下架）' }
      })
  }

  function transferVideoSetStatus(id, status) {
    if (!token()) return msg('请先登录后台。', true)
    if (status === 0 && !confirm('下架该视频？小程序将回落「录播课即将上线」。')) return
    function updateMeta() {
      return api('/api/admin/transfer/video/' + id + '/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: status }),
      })
    }
    var p = Promise.resolve()
    if (status === 0) {
      // 下架顺手把桥机文件移走（非硬删）；失败不阻塞状态更新
      var file = fileNameOf(videoUrlById[String(id)])
      if (file && /^[A-Za-z0-9._-]+$/.test(file)) {
        p = fetch(BRIDGE_BASE + '/admin/offline/' + encodeURIComponent(file), {
          method: 'POST',
          headers: { 'x-admin-token': token() },
        }).catch(function () {}).then(function () {})
      }
    }
    p.then(updateMeta)
      .then(function (json) {
        if (!json || json.code !== 0) throw new Error((json && json.message) || '操作失败')
        return loadTransferVideoData()
      })
      .catch(function (e) {
        msg('失败：' + e.message, true)
      })
  }

  // 暴露给 HTML 里的 onclick
  window.loadTransferVideoData = loadTransferVideoData
  window.uploadTransferVideo = uploadTransferVideo
  window.transferVideoSetStatus = transferVideoSetStatus

  document.addEventListener('DOMContentLoaded', function () {
    var fileEl = $('tvFile')
    if (fileEl) {
      fileEl.addEventListener('change', function () {
        var f = fileEl.files && fileEl.files[0]
        if (f && !$('tvTitle').value) {
          $('tvTitle').value = '转专业备考课 · ' + Math.round((f.size / 1024 / 1024) * 10) / 10 + 'MB'
        }
      })
    }
  })
})()
