import { state } from './state.js';
import { updatePreview } from './preview.js';
import { saveDocument } from './persistence.js';

export async function toggleAntigravity() {
    if (state.videoClips.length === 0) return;
    const clip = state.videoClips[0];
    
    // Toggle the effect
    clip.antigravity = !clip.antigravity;
    
    const btn = document.getElementById('cupcat-antigravity-btn');
    if (clip.antigravity) {
        if (window.showToast) window.showToast('Initializing AI, please wait...', false);
        btn.style.background = 'rgba(156,39,176,0.3)'; // Highlight
        btn.innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Loading</span>';
        
        // Force pre-init
        const { initAntigravityModel } = await import('./antigravity.js');
        const model = await initAntigravityModel();
        
        if (!model) {
            clip.antigravity = false;
            btn.style.background = 'rgba(156,39,176,0.08)';
            btn.innerHTML = '<i class="fas fa-meteor" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Antigravity</span>';
            return;
        }
        
        btn.innerHTML = '<i class="fas fa-meteor" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Antigravity</span>';
    } else {
        btn.style.background = 'rgba(156,39,176,0.08)'; // Normal
    }
    
    // Rerender
    await updatePreview();
    saveDocument();
}

export function updateAntigravityButton() {
    const btn = document.getElementById('cupcat-antigravity-btn');
    if (!btn) return;
    
    if (state.videoClips.length > 0) {
        const clip = state.videoClips[0];
        if (clip.antigravity) {
            btn.style.background = 'rgba(156,39,176,0.3)';
        } else {
            btn.style.background = 'rgba(156,39,176,0.08)';
        }
    } else {
        btn.style.background = 'rgba(156,39,176,0.08)';
    }
}
