import '../sidepanel/styles.css';

const button = document.getElementById('grant') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLParagraphElement;

function show(text: string, tone: 'ok' | 'error'): void {
  status.textContent = text;
  status.dataset.tone = tone;
}

button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    // Only the grant is needed here; release the microphone immediately.
    stream.getTracks().forEach((t) => t.stop());
    show('Microphone access granted. You can close this tab and return to the side panel.', 'ok');
    button.textContent = 'Close tab';
    button.disabled = false;
    button.onclick = () => window.close();
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    show(
      name === 'NotAllowedError'
        ? 'Access was blocked. Click the microphone icon in the address bar (or the site settings) to allow it, then try again.'
        : name === 'NotFoundError'
          ? 'No microphone was found. Connect one and try again.'
          : `Could not access the microphone: ${String(err)}`,
      'error',
    );
    button.disabled = false;
  }
});
