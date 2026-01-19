// Initialize PDF.js
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Application state
const state = {
    pdfDoc: null,
    pdfBytes: null,
    currentPage: 1,
    totalPages: 0,
    scale: 1.5,
    currentTool: null,
    fields: [],
    selectedField: null,
    isDrawing: false,
    canvas: null,
    ctx: null,
    canvasOffset: { x: 0, y: 0 }
};

// Initialize signature canvas
let signatureCanvas, signatureCtx;
let isSignatureDrawing = false;

// Load saved signatures from localStorage
function loadSavedSignatures() {
    const signatures = localStorage.getItem('pdfFormSignatures');
    return signatures ? JSON.parse(signatures) : [];
}

function saveSignatureToStorage(signatureData) {
    const signatures = loadSavedSignatures();
    signatures.push({
        id: Date.now(),
        data: signatureData,
        created: new Date().toISOString()
    });
    localStorage.setItem('pdfFormSignatures', JSON.stringify(signatures));
}

function deleteSavedSignature(id) {
    const signatures = loadSavedSignatures();
    const filtered = signatures.filter(sig => sig.id !== id);
    localStorage.setItem('pdfFormSignatures', JSON.stringify(filtered));
}

// PDF Upload Handler
document.getElementById('pdfUpload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
        state.pdfBytes = new Uint8Array(event.target.result);
        await loadPDF(state.pdfBytes);
    };
    reader.readAsArrayBuffer(file);
});

// Load and render PDF
async function loadPDF(pdfBytes) {
    try {
        const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
        state.pdfDoc = await loadingTask.promise;
        state.totalPages = state.pdfDoc.numPages;
        state.currentPage = 1;

        await renderPage(state.currentPage);

        // Clear placeholder
        document.querySelector('.upload-placeholder').style.display = 'none';
    } catch (error) {
        console.error('Error loading PDF:', error);
        alert('Error loading PDF. Please try again.');
    }
}

// Render PDF page
async function renderPage(pageNum) {
    const page = await state.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: state.scale });

    // Create or get canvas
    let canvas = document.getElementById('pdfCanvas');
    if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = 'pdfCanvas';
        document.getElementById('pdfContainer').appendChild(canvas);

        // Add page controls
        if (state.totalPages > 1) {
            addPageControls();
        }
    }

    state.canvas = canvas;
    state.ctx = canvas.getContext('2d');

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    // Update canvas offset for field positioning
    const rect = canvas.getBoundingClientRect();
    state.canvasOffset = {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY
    };

    const renderContext = {
        canvasContext: state.ctx,
        viewport: viewport
    };

    await page.render(renderContext).promise;

    // Re-render fields on this page
    renderFields();
}

// Add page navigation controls
function addPageControls() {
    const controls = document.createElement('div');
    controls.className = 'page-controls';
    controls.innerHTML = `
        <button onclick="previousPage()" id="prevPage">Previous</button>
        <span>Page <span id="pageNum">${state.currentPage}</span> of <span id="pageCount">${state.totalPages}</span></span>
        <button onclick="nextPage()" id="nextPage">Next</button>
    `;
    document.querySelector('.canvas-wrapper').appendChild(controls);
}

function nextPage() {
    if (state.currentPage < state.totalPages) {
        state.currentPage++;
        renderPage(state.currentPage);
        updatePageControls();
    }
}

function previousPage() {
    if (state.currentPage > 1) {
        state.currentPage--;
        renderPage(state.currentPage);
        updatePageControls();
    }
}

function updatePageControls() {
    document.getElementById('pageNum').textContent = state.currentPage;
    document.getElementById('prevPage').disabled = state.currentPage === 1;
    document.getElementById('nextPage').disabled = state.currentPage === state.totalPages;
}

// Tool selection
document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        // Remove active class from all buttons
        document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));

        // Add active class to clicked button
        e.target.classList.add('active');

        // Set current tool
        state.currentTool = e.target.dataset.tool;
    });
});

// Canvas click handler for adding fields
document.addEventListener('click', (e) => {
    if (!state.canvas) return;

    const canvas = state.canvas;
    const rect = canvas.getBoundingClientRect();

    if (e.target === canvas && state.currentTool) {
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        addField(state.currentTool, x, y);
    }
});

// Add form field
function addField(type, x, y) {
    const field = {
        id: Date.now(),
        type: type,
        x: x,
        y: y,
        page: state.currentPage,
        width: type === 'checkbox' ? 20 : 150,
        height: type === 'checkbox' ? 20 : 30,
        fontSize: 12,
        fontFamily: 'Helvetica',
        textColor: '#000000',
        bgColor: '#ffffff',
        borderColor: '#000000',
        borderWidth: 1,
        name: `field_${Date.now()}`,
        value: type === 'checkmark' ? '✓' :
               type === 'cross' ? '✗' :
               type === 'arrow' ? '→' :
               type === 'star' ? '★' :
               type === 'exclamation' ? '❗' : ''
    };

    state.fields.push(field);
    renderFields();
}

// Render all fields
function renderFields() {
    // Remove existing field elements
    document.querySelectorAll('.form-field').forEach(el => el.remove());

    // Render fields for current page
    state.fields.filter(f => f.page === state.currentPage).forEach(field => {
        const fieldEl = document.createElement('div');
        fieldEl.className = 'form-field';
        fieldEl.dataset.fieldId = field.id;

        if (field.type === 'checkbox') {
            fieldEl.classList.add('checkbox');
        } else if (field.type === 'signature') {
            fieldEl.classList.add('signature');
            fieldEl.textContent = 'Signature';
        } else if (['checkmark', 'cross', 'arrow', 'star', 'exclamation'].includes(field.type)) {
            fieldEl.classList.add('indicator');
            fieldEl.textContent = field.value;
        } else {
            fieldEl.textContent = 'Text Field';
        }

        fieldEl.style.left = field.x + 'px';
        fieldEl.style.top = field.y + 'px';
        fieldEl.style.width = field.width + 'px';
        fieldEl.style.height = field.height + 'px';
        fieldEl.style.color = field.textColor;
        fieldEl.style.backgroundColor = field.bgColor;
        fieldEl.style.borderColor = field.borderColor;
        fieldEl.style.borderWidth = field.borderWidth + 'px';
        fieldEl.style.fontSize = field.fontSize + 'px';

        // Make field draggable and selectable
        fieldEl.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            selectField(field.id);

            const startX = e.clientX - field.x;
            const startY = e.clientY - field.y;

            function onMouseMove(e) {
                const canvas = state.canvas;
                const rect = canvas.getBoundingClientRect();
                field.x = e.clientX - rect.left - startX;
                field.y = e.clientY - rect.top - startY;
                renderFields();
            }

            function onMouseUp() {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            }

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        document.getElementById('pdfContainer').appendChild(fieldEl);
    });
}

// Select field
function selectField(fieldId) {
    state.selectedField = state.fields.find(f => f.id === fieldId);

    // Update UI
    document.querySelectorAll('.form-field').forEach(el => {
        el.classList.remove('selected');
    });

    const fieldEl = document.querySelector(`[data-field-id="${fieldId}"]`);
    if (fieldEl) {
        fieldEl.classList.add('selected');
    }

    // Show properties panel
    showProperties();
}

// Show properties panel
function showProperties() {
    if (!state.selectedField) return;

    const panel = document.getElementById('propertiesPanel');
    panel.style.display = 'block';

    const field = state.selectedField;
    document.getElementById('propWidth').value = field.width;
    document.getElementById('propHeight').value = field.height;
    document.getElementById('propFontSize').value = field.fontSize;
    document.getElementById('propFontFamily').value = field.fontFamily;
    document.getElementById('propTextColor').value = field.textColor;
    document.getElementById('propBgColor').value = field.bgColor;
    document.getElementById('propBorderColor').value = field.borderColor;
    document.getElementById('propBorderWidth').value = field.borderWidth;
    document.getElementById('propFieldName').value = field.name;

    // Add event listeners for property changes
    const propertyInputs = ['propWidth', 'propHeight', 'propFontSize', 'propFontFamily',
                           'propTextColor', 'propBgColor', 'propBorderColor', 'propBorderWidth', 'propFieldName'];

    propertyInputs.forEach(inputId => {
        const input = document.getElementById(inputId);
        input.onchange = () => updateFieldProperties();
    });
}

// Update field properties
function updateFieldProperties() {
    if (!state.selectedField) return;

    state.selectedField.width = parseInt(document.getElementById('propWidth').value);
    state.selectedField.height = parseInt(document.getElementById('propHeight').value);
    state.selectedField.fontSize = parseInt(document.getElementById('propFontSize').value);
    state.selectedField.fontFamily = document.getElementById('propFontFamily').value;
    state.selectedField.textColor = document.getElementById('propTextColor').value;
    state.selectedField.bgColor = document.getElementById('propBgColor').value;
    state.selectedField.borderColor = document.getElementById('propBorderColor').value;
    state.selectedField.borderWidth = parseInt(document.getElementById('propBorderWidth').value);
    state.selectedField.name = document.getElementById('propFieldName').value;

    renderFields();
}

// Delete selected field
function deleteSelectedField() {
    if (!state.selectedField) return;

    state.fields = state.fields.filter(f => f.id !== state.selectedField.id);
    state.selectedField = null;
    document.getElementById('propertiesPanel').style.display = 'none';
    renderFields();
}

// Clear all fields
function clearAll() {
    if (confirm('Are you sure you want to clear all fields?')) {
        state.fields = [];
        state.selectedField = null;
        document.getElementById('propertiesPanel').style.display = 'none';
        renderFields();
    }
}

// Signature Modal Functions
function openSignatureModal() {
    const modal = document.getElementById('signatureModal');
    modal.style.display = 'block';

    signatureCanvas = document.getElementById('signatureCanvas');
    signatureCtx = signatureCanvas.getContext('2d');

    // Set up drawing
    signatureCanvas.addEventListener('mousedown', startSignatureDrawing);
    signatureCanvas.addEventListener('mousemove', drawSignature);
    signatureCanvas.addEventListener('mouseup', stopSignatureDrawing);
    signatureCanvas.addEventListener('mouseleave', stopSignatureDrawing);

    // Touch support
    signatureCanvas.addEventListener('touchstart', handleTouchStart);
    signatureCanvas.addEventListener('touchmove', handleTouchMove);
    signatureCanvas.addEventListener('touchend', stopSignatureDrawing);
}

function closeSignatureModal() {
    document.getElementById('signatureModal').style.display = 'none';
}

function startSignatureDrawing(e) {
    isSignatureDrawing = true;
    const rect = signatureCanvas.getBoundingClientRect();
    signatureCtx.beginPath();
    signatureCtx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
}

function drawSignature(e) {
    if (!isSignatureDrawing) return;
    const rect = signatureCanvas.getBoundingClientRect();
    signatureCtx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
    signatureCtx.strokeStyle = '#000';
    signatureCtx.lineWidth = 2;
    signatureCtx.lineCap = 'round';
    signatureCtx.stroke();
}

function stopSignatureDrawing() {
    isSignatureDrawing = false;
}

function handleTouchStart(e) {
    e.preventDefault();
    const touch = e.touches[0];
    const rect = signatureCanvas.getBoundingClientRect();
    isSignatureDrawing = true;
    signatureCtx.beginPath();
    signatureCtx.moveTo(touch.clientX - rect.left, touch.clientY - rect.top);
}

function handleTouchMove(e) {
    e.preventDefault();
    if (!isSignatureDrawing) return;
    const touch = e.touches[0];
    const rect = signatureCanvas.getBoundingClientRect();
    signatureCtx.lineTo(touch.clientX - rect.left, touch.clientY - rect.top);
    signatureCtx.strokeStyle = '#000';
    signatureCtx.lineWidth = 2;
    signatureCtx.lineCap = 'round';
    signatureCtx.stroke();
}

function clearSignature() {
    signatureCtx.clearRect(0, 0, signatureCanvas.width, signatureCanvas.height);
}

function saveSignature() {
    const signatureData = signatureCanvas.toDataURL();
    saveSignatureToStorage(signatureData);
    alert('Signature saved successfully!');
    closeSignatureModal();
}

// View saved signatures
function viewSavedSignatures() {
    const modal = document.getElementById('savedSignaturesModal');
    modal.style.display = 'block';

    const signatures = loadSavedSignatures();
    const list = document.getElementById('savedSignaturesList');
    list.innerHTML = '';

    if (signatures.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: #6c757d;">No saved signatures</p>';
        return;
    }

    signatures.forEach(sig => {
        const item = document.createElement('div');
        item.className = 'saved-signature-item';
        item.innerHTML = `
            <img src="${sig.data}" alt="Signature">
            <div class="signature-actions-small">
                <button class="use-btn" onclick="useSavedSignature('${sig.data}')">Use</button>
                <button class="delete-btn" onclick="deleteSig(${sig.id})">Delete</button>
            </div>
        `;
        list.appendChild(item);
    });
}

function closeSavedSignaturesModal() {
    document.getElementById('savedSignaturesModal').style.display = 'none';
}

function useSavedSignature(signatureData) {
    // Store signature data for the next signature field click
    state.pendingSignature = signatureData;
    state.currentTool = 'signature';

    // Activate signature tool
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    const sigBtn = document.querySelector('[data-tool="signature"]');
    if (sigBtn) sigBtn.classList.add('active');

    closeSavedSignaturesModal();
    alert('Click on the PDF where you want to place the signature');
}

function deleteSig(id) {
    if (confirm('Delete this signature?')) {
        deleteSavedSignature(id);
        viewSavedSignatures();
    }
}

// Download PDF with form fields
async function downloadPDF() {
    if (!state.pdfBytes) {
        alert('Please upload a PDF first');
        return;
    }

    try {
        // Load the PDF with pdf-lib
        const pdfDoc = await PDFLib.PDFDocument.load(state.pdfBytes);
        const form = pdfDoc.getForm();
        const pages = pdfDoc.getPages();

        // Process each field
        for (const field of state.fields) {
            const page = pages[field.page - 1];
            const { width, height } = page.getSize();

            // Convert coordinates (PDF coordinates start from bottom-left)
            const pdfY = height - field.y - field.height;
            const pdfX = field.x;

            // Parse colors
            const rgb = hexToRgb(field.textColor);
            const bgRgb = hexToRgb(field.bgColor);
            const borderRgb = hexToRgb(field.borderColor);

            if (field.type === 'text') {
                const textField = form.createTextField(field.name);
                textField.addToPage(page, {
                    x: pdfX,
                    y: pdfY,
                    width: field.width,
                    height: field.height,
                    textColor: PDFLib.rgb(rgb.r / 255, rgb.g / 255, rgb.b / 255),
                    backgroundColor: PDFLib.rgb(bgRgb.r / 255, bgRgb.g / 255, bgRgb.b / 255),
                    borderColor: PDFLib.rgb(borderRgb.r / 255, borderRgb.g / 255, borderRgb.b / 255),
                    borderWidth: field.borderWidth,
                });
                textField.setFontSize(field.fontSize);
            } else if (field.type === 'checkbox') {
                const checkBox = form.createCheckBox(field.name);
                checkBox.addToPage(page, {
                    x: pdfX,
                    y: pdfY,
                    width: field.width,
                    height: field.height,
                    borderColor: PDFLib.rgb(borderRgb.r / 255, borderRgb.g / 255, borderRgb.b / 255),
                    borderWidth: field.borderWidth,
                });
            } else if (field.type === 'signature') {
                // Draw signature area
                page.drawRectangle({
                    x: pdfX,
                    y: pdfY,
                    width: field.width,
                    height: field.height,
                    borderColor: PDFLib.rgb(borderRgb.r / 255, borderRgb.g / 255, borderRgb.b / 255),
                    borderWidth: field.borderWidth,
                    color: PDFLib.rgb(bgRgb.r / 255, bgRgb.g / 255, bgRgb.b / 255),
                });

                // Add a text field for signature
                const sigField = form.createTextField(field.name);
                sigField.addToPage(page, {
                    x: pdfX,
                    y: pdfY,
                    width: field.width,
                    height: field.height,
                });
            } else if (['checkmark', 'cross', 'arrow', 'star', 'exclamation'].includes(field.type)) {
                // Draw indicator symbols
                page.drawText(field.value, {
                    x: pdfX,
                    y: pdfY + 5,
                    size: field.fontSize * 1.5,
                    color: PDFLib.rgb(rgb.r / 255, rgb.g / 255, rgb.b / 255),
                });
            }
        }

        // Save the PDF
        const pdfBytes = await pdfDoc.save();

        // Download
        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'fillable-form.pdf';
        a.click();
        URL.revokeObjectURL(url);

        alert('PDF downloaded successfully!');
    } catch (error) {
        console.error('Error creating PDF:', error);
        alert('Error creating PDF. Please try again.');
    }
}

// Helper function to convert hex to RGB
function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : { r: 0, g: 0, b: 0 };
}

// Close modals when clicking outside
window.onclick = function(event) {
    const signatureModal = document.getElementById('signatureModal');
    const savedSignaturesModal = document.getElementById('savedSignaturesModal');

    if (event.target === signatureModal) {
        closeSignatureModal();
    }
    if (event.target === savedSignaturesModal) {
        closeSavedSignaturesModal();
    }
}

// Initialize
console.log('PDF Form Builder initialized');
