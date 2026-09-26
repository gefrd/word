// Save a Blob as a file (works on Android Chrome, iOS Safari and desktop).
export function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    // Revoke late: mobile download managers read the blob asynchronously.
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 20000);
}
