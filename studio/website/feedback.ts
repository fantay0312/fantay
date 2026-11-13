document.getElementById('feedback-form')?.addEventListener('submit', function (event) {
  event.preventDefault();
  const category = document.getElementById('category').value;
  const subject = document.getElementById('subject').value.trim();
  const body = document.getElementById('details').value.trim();
  if (!subject || !body) return;
  window.location.href = 'mailto:support@tokentosea.com?subject=' + encodeURIComponent('[Fantay][' + category + '] ' + subject) + '&body=' + encodeURIComponent(body);
  document.getElementById('feedback-status').textContent = '正在打开邮件客户端。页面尚未发送任何内容；请在邮件中确认后发送。';
});
