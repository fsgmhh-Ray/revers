// 弹窗：展示各平台登录态探测结果

const PLATFORMS = ['youtube', 'instagram', 'tiktok'];

chrome.runtime.sendMessage(
  { channel: 'CINEFLOW_EXT_V1', action: 'HELLO', payload: {} },
  (res) => {
    const authed = res?.ok ? res.data?.authed || [] : [];
    PLATFORMS.forEach((p) => {
      const dot = document.getElementById(`d-${p}`);
      const tag = document.getElementById(`t-${p}`);
      if (!dot || !tag) return;
      const logged = authed.includes(p);
      dot.classList.toggle('on', logged);
      tag.textContent = logged ? '已登录' : '未登录';
    });
  },
);
