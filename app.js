// PDF.js worker configuration
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Application state
const state = {
    pdfDoc: null,
    pdfBytes: null,
    currentPage: 1,
    totalPages: 0,
    zoom: 1,
    fields: [],
    selectedField: null,
    currentTool: null,
    isDrawing: false,
    dragStart: null,
    currentSymbol: null,
    signatures: [],
    fieldIdCounter: 0
};

// DOM Elements
const elements = {
    uploadSection: document.getElementById('uploadSection'),
    editorSection: document.getElementById('editorSection'),
    pdfInput: document.getElementById('pdfInput'),
    uploadBox: document.getElementById('uploadBox'),
    canvas: document.getElementById('pdfCanvas'),
    fieldsOverlay: document.getElementById('fieldsOverlay'),
    currentPageSpan: document.getElementById('currentPage'),
    totalPagesSpan: document.getElementById('totalPages'),
    prevPageBtn: document.getElementById('prevPage'),
    nextPageBtn: document.getElementById('nextPage'),
    zoomInBtn: document.getElementById('zoomIn'),
    zoomOutBtn: document.getElementById('zoomOut'),
    zoomLevelSpan: document.getElementById('zoomLevel'),
    propertiesPanel: document.getElementById('propertiesPanel'),
    propertiesContent: document.getElementById('propertiesContent'),
    downloadBtn: document.getElementById('downloadBtn'),
    newPdfBtn: document.getElementById('newPdfBtn'),
    clearAllBtn: document.getElementById('clearAllBtn'),
    signatureModal: document.getElementById('signatureModal'),
    createSignatureBtn: document.getElementById('createSignatureBtn'),
    signatureCanvas: document.getElementById('signatureCanvas'),
    typedSignatureCanvas: document.getElementById('typedSignatureCanvas'),
    signatureText: document.getElementById('signatureText'),
    signatureFont: document.getElementById('signatureFont'),
    canvasWrapper: document.getElementById('canvasWrapper')
};

// Initialize application
function init() {
    setupEventListeners();
    loadSavedSignatures();
    setupSignatureCanvas();
}

// Event Listeners
function setupEventListeners() {
    // File upload
    elements.pdfInput.addEventListener('change', handleFileSelect);
    elements.uploadBox.addEventListener('click', () => elements.pdfInput.click());

    // Drag and drop
    elements.uploadBox.addEventListener('dragover', handleDragOver);
    elements.uploadBox.addEventListener('dragleave', handleDragLeave);
    elements.uploadBox.addEventListener('drop', handleDrop);

    // Tool buttons
    document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tool = e.currentTarget.getAttribute('data-tool');
            const symbol = e.currentTarget.getAttribute('data-symbol');
            selectTool(tool, symbol);
        });
    });

    // Page navigation
    elements.prevPageBtn.addEventListener('click', () => changePage(-1));
    elements.nextPageBtn.addEventListener('click', () => changePage(1));

    // Zoom controls
    elements.zoomInBtn.addEventListener('click', () => changeZoom(0.1));
    elements.zoomOutBtn.addEventListener('click', () => changeZoom(-0.1));

    // Canvas interactions
    elements.canvasWrapper.addEventListener('mousedown', handleCanvasMouseDown);
    elements.canvasWrapper.addEventListener('mousemove', handleCanvasMouseMove);
    elements.canvasWrapper.addEventListener('mouseup', handleCanvasMouseUp);

    // Action buttons
    elements.downloadBtn.addEventListener('click', downloadFillablePDF);
    elements.newPdfBtn.addEventListener('click', resetApp);
    elements.clearAllBtn.addEventListener('click', clearAllFields);
    elements.createSignatureBtn.addEventListener('click', openSignatureModal);

    // Signature modal
    document.getElementById('closeSignatureModal').addEventListener('click', closeSignatureModal);
    document.getElementById('cancelSignature').addEventListener('click', closeSignatureModal);
    document.getElementById('saveSignature').addEventListener('click', saveSignature);
    document.getElementById('clearSignature').addEventListener('click', clearSignatureCanvas);

    // Signature tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tab = e.target.getAttribute('data-tab');
            switchSignatureTab(tab);
        });
    });

    // Typed signature
    elements.signatureText.addEventListener('input', updateTypedSignature);
    elements.signatureFont.addEventListener('change', updateTypedSignature);

    // Deselect field when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.form-field') && !e.target.closest('.properties-panel')) {
            deselectField();
        }
    });
}

// File handling
function handleFileSelect(e) {
    const file = e.target.files[0];
    if (file && file.type === 'application/pdf') {
        loadPDF(file);
    }
}

function handleDragOver(e) {
    e.preventDefault();
    elements.uploadBox.classList.add('dragover');
}

function handleDragLeave(e) {
    e.preventDefault();
    elements.uploadBox.classList.remove('dragover');
}

function handleDrop(e) {
    e.preventDefault();
    elements.uploadBox.classList.remove('dragover');

    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') {
        loadPDF(file);
    }
}

// Load and render PDF
async function loadPDF(file) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        state.pdfBytes = new Uint8Array(arrayBuffer);

        const loadingTask = pdfjsLib.getDocument({ data: state.pdfBytes });
        state.pdfDoc = await loadingTask.promise;
        state.totalPages = state.pdfDoc.numPages;
        state.currentPage = 1;

        elements.uploadSection.style.display = 'none';
        elements.editorSection.style.display = 'grid';

        renderPage();
        updatePageInfo();
    } catch (error) {
        console.error('Error loading PDF:', error);
        alert('Error loading PDF. Please try another file.');
    }
}

async function renderPage() {
    if (!state.pdfDoc) return;

    const page = await state.pdfDoc.getPage(state.currentPage);
    const viewport = page.getViewport({ scale: state.zoom });

    elements.canvas.width = viewport.width;
    elements.canvas.height = viewport.height;

    const ctx = elements.canvas.getContext('2d');
    await page.render({
        canvasContext: ctx,
        viewport: viewport
    }).promise;

    // Update overlay size
    elements.fieldsOverlay.style.width = viewport.width + 'px';
    elements.fieldsOverlay.style.height = viewport.height + 'px';

    // Render fields for current page
    renderFields();
}

function updatePageInfo() {
    elements.currentPageSpan.textContent = state.currentPage;
    elements.totalPagesSpan.textContent = state.totalPages;
    elements.prevPageBtn.disabled = state.currentPage === 1;
    elements.nextPageBtn.disabled = state.currentPage === state.totalPages;
}

function changePage(delta) {
    const newPage = state.currentPage + delta;
    if (newPage >= 1 && newPage <= state.totalPages) {
        state.currentPage = newPage;
        renderPage();
        updatePageInfo();
    }
}

function changeZoom(delta) {
    state.zoom = Math.max(0.5, Math.min(3, state.zoom + delta));
    elements.zoomLevelSpan.textContent = Math.round(state.zoom * 100) + '%';
    renderPage();
}

// Tool selection
function selectTool(tool, symbol = null) {
    // Deselect previous tool
    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    // Select new tool
    const activeTool = document.querySelector(`.tool-btn[data-tool="${tool}"]${symbol ? `[data-symbol="${symbol}"]` : ''}`);
    if (activeTool) {
        activeTool.classList.add('active');
    }

    state.currentTool = tool;
    state.currentSymbol = symbol;

    // Change cursor
    elements.canvasWrapper.style.cursor = tool ? 'crosshair' : 'default';
}

// Canvas interactions
function handleCanvasMouseDown(e) {
    if (!state.currentTool) return;

    const rect = elements.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (state.currentTool === 'indicator') {
        addIndicator(x, y);
        return;
    }

    state.isDrawing = true;
    state.dragStart = { x, y };
}

function handleCanvasMouseMove(e) {
    if (!state.isDrawing || !state.dragStart) return;

    const rect = elements.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Show preview (optional - could add visual feedback here)
}

function handleCanvasMouseUp(e) {
    if (!state.isDrawing || !state.dragStart) return;

    const rect = elements.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const width = Math.abs(x - state.dragStart.x);
    const height = Math.abs(y - state.dragStart.y);

    // Minimum size
    if (width < 20 || height < 20) {
        state.isDrawing = false;
        state.dragStart = null;
        return;
    }

    const field = {
        id: ++state.fieldIdCounter,
        type: state.currentTool,
        page: state.currentPage,
        x: Math.min(state.dragStart.x, x),
        y: Math.min(state.dragStart.y, y),
        width: width,
        height: height,
        fontSize: 12,
        fontFamily: 'Helvetica',
        fontColor: '#000000',
        backgroundColor: '#ffffff',
        borderColor: '#000000',
        borderWidth: 1,
        required: false
    };

    state.fields.push(field);
    renderFields();
    selectField(field);

    state.isDrawing = false;
    state.dragStart = null;
}

// Field rendering
function renderFields() {
    elements.fieldsOverlay.innerHTML = '';

    state.fields
        .filter(f => f.page === state.currentPage)
        .forEach(field => {
            if (field.type === 'indicator') {
                renderIndicator(field);
            } else {
                renderFormField(field);
            }
        });
}

function renderFormField(field) {
    const fieldEl = document.createElement('div');
    fieldEl.className = `form-field ${field.type}-field`;
    if (state.selectedField?.id === field.id) {
        fieldEl.classList.add('selected');
    }

    fieldEl.style.left = field.x + 'px';
    fieldEl.style.top = field.y + 'px';
    fieldEl.style.width = field.width + 'px';
    fieldEl.style.height = field.height + 'px';
    fieldEl.style.borderColor = field.borderColor || '#4f46e5';
    fieldEl.style.borderWidth = (field.borderWidth || 1) + 'px';

    // Label
    const label = document.createElement('div');
    label.className = 'field-label';
    label.textContent = field.type.charAt(0).toUpperCase() + field.type.slice(1);
    fieldEl.appendChild(label);

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = '×';
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteField(field);
    });
    fieldEl.appendChild(deleteBtn);

    // Resize handles
    if (state.selectedField?.id === field.id) {
        ['nw', 'ne', 'sw', 'se'].forEach(pos => {
            const handle = document.createElement('div');
            handle.className = `resize-handle ${pos}`;
            handle.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                startResize(e, field, pos);
            });
            fieldEl.appendChild(handle);
        });
    }

    // Click to select
    fieldEl.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        selectField(field);
        startDrag(e, field);
    });

    elements.fieldsOverlay.appendChild(fieldEl);
}

function renderIndicator(field) {
    const indicatorEl = document.createElement('div');
    indicatorEl.className = 'indicator-symbol';
    indicatorEl.textContent = field.symbol;
    indicatorEl.style.left = field.x + 'px';
    indicatorEl.style.top = field.y + 'px';
    indicatorEl.style.fontSize = (field.size || 24) + 'px';
    indicatorEl.style.color = field.color || '#000000';

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = '×';
    deleteBtn.style.display = 'none';
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteField(field);
    });
    indicatorEl.appendChild(deleteBtn);

    indicatorEl.addEventListener('mouseenter', () => {
        deleteBtn.style.display = 'flex';
    });

    indicatorEl.addEventListener('mouseleave', () => {
        deleteBtn.style.display = 'none';
    });

    indicatorEl.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        startDrag(e, field);
    });

    elements.fieldsOverlay.appendChild(indicatorEl);
}

function addIndicator(x, y) {
    const field = {
        id: ++state.fieldIdCounter,
        type: 'indicator',
        page: state.currentPage,
        symbol: state.currentSymbol,
        x: x,
        y: y,
        size: 24,
        color: '#000000'
    };

    state.fields.push(field);
    renderFields();
}

// Field interaction
function selectField(field) {
    state.selectedField = field;
    renderFields();
    showProperties(field);
}

function deselectField() {
    state.selectedField = null;
    elements.propertiesPanel.style.display = 'none';
    renderFields();
}

function deleteField(field) {
    state.fields = state.fields.filter(f => f.id !== field.id);
    if (state.selectedField?.id === field.id) {
        deselectField();
    }
    renderFields();
}

function clearAllFields() {
    if (confirm('Are you sure you want to clear all fields?')) {
        state.fields = [];
        deselectField();
        renderFields();
    }
}

// Drag and resize
let dragState = null;
let resizeState = null;

function startDrag(e, field) {
    const rect = elements.canvas.getBoundingClientRect();
    dragState = {
        field: field,
        startX: e.clientX - rect.left - field.x,
        startY: e.clientY - rect.top - field.y
    };

    const handleDragMove = (e) => {
        if (!dragState) return;

        const rect = elements.canvas.getBoundingClientRect();
        const newX = e.clientX - rect.left - dragState.startX;
        const newY = e.clientY - rect.top - dragState.startY;

        dragState.field.x = Math.max(0, Math.min(elements.canvas.width - dragState.field.width, newX));
        dragState.field.y = Math.max(0, Math.min(elements.canvas.height - dragState.field.height, newY));

        renderFields();
        showProperties(dragState.field);
    };

    const handleDragEnd = () => {
        dragState = null;
        document.removeEventListener('mousemove', handleDragMove);
        document.removeEventListener('mouseup', handleDragEnd);
    };

    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleDragEnd);
}

function startResize(e, field, corner) {
    e.stopPropagation();

    resizeState = {
        field: field,
        corner: corner,
        startX: e.clientX,
        startY: e.clientY,
        startWidth: field.width,
        startHeight: field.height,
        startFieldX: field.x,
        startFieldY: field.y
    };

    const handleResizeMove = (e) => {
        if (!resizeState) return;

        const dx = e.clientX - resizeState.startX;
        const dy = e.clientY - resizeState.startY;

        const minSize = 20;

        switch (resizeState.corner) {
            case 'se':
                resizeState.field.width = Math.max(minSize, resizeState.startWidth + dx);
                resizeState.field.height = Math.max(minSize, resizeState.startHeight + dy);
                break;
            case 'sw':
                resizeState.field.width = Math.max(minSize, resizeState.startWidth - dx);
                resizeState.field.height = Math.max(minSize, resizeState.startHeight + dy);
                resizeState.field.x = resizeState.startFieldX + dx;
                break;
            case 'ne':
                resizeState.field.width = Math.max(minSize, resizeState.startWidth + dx);
                resizeState.field.height = Math.max(minSize, resizeState.startHeight - dy);
                resizeState.field.y = resizeState.startFieldY + dy;
                break;
            case 'nw':
                resizeState.field.width = Math.max(minSize, resizeState.startWidth - dx);
                resizeState.field.height = Math.max(minSize, resizeState.startHeight - dy);
                resizeState.field.x = resizeState.startFieldX + dx;
                resizeState.field.y = resizeState.startFieldY + dy;
                break;
        }

        renderFields();
        showProperties(resizeState.field);
    };

    const handleResizeEnd = () => {
        resizeState = null;
        document.removeEventListener('mousemove', handleResizeMove);
        document.removeEventListener('mouseup', handleResizeEnd);
    };

    document.addEventListener('mousemove', handleResizeMove);
    document.addEventListener('mouseup', handleResizeEnd);
}

// Properties panel
function showProperties(field) {
    elements.propertiesPanel.style.display = 'block';

    let html = '';

    if (field.type === 'indicator') {
        html = `
            <div class="property-group">
                <label>Symbol</label>
                <input type="text" value="${field.symbol}" maxlength="2"
                       onchange="updateFieldProperty(${field.id}, 'symbol', this.value)">
            </div>
            <div class="property-group">
                <label>Size: <span id="sizeValue">${field.size || 24}</span>px</label>
                <input type="range" min="12" max="72" value="${field.size || 24}"
                       oninput="document.getElementById('sizeValue').textContent = this.value; updateFieldProperty(${field.id}, 'size', parseInt(this.value))">
            </div>
            <div class="property-group">
                <label>Color</label>
                <input type="color" value="${field.color || '#000000'}"
                       onchange="updateFieldProperty(${field.id}, 'color', this.value)">
            </div>
        `;
    } else {
        html = `
            <div class="property-group">
                <label>Field Name</label>
                <input type="text" value="${field.name || field.type}"
                       onchange="updateFieldProperty(${field.id}, 'name', this.value)">
            </div>
            <div class="property-group">
                <label>Width: ${field.width}px</label>
                <input type="number" value="${field.width}" min="20"
                       onchange="updateFieldProperty(${field.id}, 'width', parseInt(this.value))">
            </div>
            <div class="property-group">
                <label>Height: ${field.height}px</label>
                <input type="number" value="${field.height}" min="20"
                       onchange="updateFieldProperty(${field.id}, 'height', parseInt(this.value))">
            </div>
            <div class="property-group">
                <label>Font Size: ${field.fontSize}px</label>
                <input type="range" min="8" max="72" value="${field.fontSize}"
                       oninput="updateFieldProperty(${field.id}, 'fontSize', parseInt(this.value))">
            </div>
            <div class="property-group">
                <label>Font Family</label>
                <select onchange="updateFieldProperty(${field.id}, 'fontFamily', this.value)">
                    <option value="Helvetica" ${field.fontFamily === 'Helvetica' ? 'selected' : ''}>Helvetica</option>
                    <option value="Times-Roman" ${field.fontFamily === 'Times-Roman' ? 'selected' : ''}>Times</option>
                    <option value="Courier" ${field.fontFamily === 'Courier' ? 'selected' : ''}>Courier</option>
                </select>
            </div>
            <div class="property-group">
                <label>Border Color</label>
                <input type="color" value="${field.borderColor || '#000000'}"
                       onchange="updateFieldProperty(${field.id}, 'borderColor', this.value)">
            </div>
            <div class="property-group">
                <label>Border Width: ${field.borderWidth}px</label>
                <input type="range" min="0" max="5" value="${field.borderWidth}"
                       oninput="updateFieldProperty(${field.id}, 'borderWidth', parseInt(this.value))">
            </div>
            <div class="property-group">
                <label>
                    <input type="checkbox" ${field.required ? 'checked' : ''}
                           onchange="updateFieldProperty(${field.id}, 'required', this.checked)">
                    Required Field
                </label>
            </div>
        `;
    }

    elements.propertiesContent.innerHTML = html;
}

window.updateFieldProperty = function(fieldId, property, value) {
    const field = state.fields.find(f => f.id === fieldId);
    if (field) {
        field[property] = value;
        renderFields();
        showProperties(field);
    }
};

// Signature functionality
let signatureDrawing = false;
let signatureCtx = null;
let lastPos = null;

function setupSignatureCanvas() {
    const canvas = elements.signatureCanvas;
    canvas.width = canvas.offsetWidth;
    canvas.height = 200;
    signatureCtx = canvas.getContext('2d');

    canvas.addEventListener('mousedown', startSignatureDrawing);
    canvas.addEventListener('mousemove', drawSignature);
    canvas.addEventListener('mouseup', stopSignatureDrawing);
    canvas.addEventListener('mouseleave', stopSignatureDrawing);

    // Touch support
    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const touch = e.touches[0];
        const mouseEvent = new MouseEvent('mousedown', {
            clientX: touch.clientX,
            clientY: touch.clientY
        });
        canvas.dispatchEvent(mouseEvent);
    });

    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        const touch = e.touches[0];
        const mouseEvent = new MouseEvent('mousemove', {
            clientX: touch.clientX,
            clientY: touch.clientY
        });
        canvas.dispatchEvent(mouseEvent);
    });

    canvas.addEventListener('touchend', (e) => {
        e.preventDefault();
        const mouseEvent = new MouseEvent('mouseup', {});
        canvas.dispatchEvent(mouseEvent);
    });
}

function startSignatureDrawing(e) {
    signatureDrawing = true;
    const rect = elements.signatureCanvas.getBoundingClientRect();
    lastPos = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
    };
}

function drawSignature(e) {
    if (!signatureDrawing) return;

    const rect = elements.signatureCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    signatureCtx.strokeStyle = document.getElementById('signatureColor').value;
    signatureCtx.lineWidth = document.getElementById('lineWidth').value;
    signatureCtx.lineCap = 'round';
    signatureCtx.lineJoin = 'round';

    signatureCtx.beginPath();
    signatureCtx.moveTo(lastPos.x, lastPos.y);
    signatureCtx.lineTo(x, y);
    signatureCtx.stroke();

    lastPos = { x, y };
}

function stopSignatureDrawing() {
    signatureDrawing = false;
}

function clearSignatureCanvas() {
    signatureCtx.clearRect(0, 0, elements.signatureCanvas.width, elements.signatureCanvas.height);
}

function updateTypedSignature() {
    const canvas = elements.typedSignatureCanvas;
    const ctx = canvas.getContext('2d');
    const text = elements.signatureText.value;
    const font = elements.signatureFont.value;

    canvas.width = canvas.offsetWidth;
    canvas.height = 200;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `48px ${font}`;
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
}

function openSignatureModal() {
    elements.signatureModal.style.display = 'flex';
    loadSavedSignatures();
}

function closeSignatureModal() {
    elements.signatureModal.style.display = 'none';
}

function switchSignatureTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });

    document.querySelector(`.tab-btn[data-tab="${tabName}"]`).classList.add('active');
    document.getElementById(tabName + 'Tab').classList.add('active');
}

function saveSignature() {
    const activeTab = document.querySelector('.tab-content.active').id;
    let signatureData = null;

    if (activeTab === 'drawTab') {
        signatureData = elements.signatureCanvas.toDataURL();
    } else if (activeTab === 'typeTab') {
        signatureData = elements.typedSignatureCanvas.toDataURL();
    }

    if (signatureData && signatureData !== elements.signatureCanvas.toDataURL('image/png', 0)) {
        // Save to localStorage
        const signatures = JSON.parse(localStorage.getItem('signatures') || '[]');
        signatures.push({
            id: Date.now(),
            data: signatureData,
            date: new Date().toISOString()
        });
        localStorage.setItem('signatures', JSON.stringify(signatures));

        // Store current signature
        state.currentSignatureData = signatureData;

        closeSignatureModal();
        alert('Signature saved! You can now use it in signature fields.');
    } else {
        alert('Please create a signature first.');
    }
}

function loadSavedSignatures() {
    const signatures = JSON.parse(localStorage.getItem('signatures') || '[]');
    const container = document.getElementById('savedSignatures');
    const emptyMessage = document.querySelector('#savedTab .empty-message');

    if (signatures.length === 0) {
        container.innerHTML = '';
        emptyMessage.style.display = 'block';
        return;
    }

    emptyMessage.style.display = 'none';
    container.innerHTML = signatures.map(sig => `
        <div class="saved-signature-item" onclick="useSignature(${sig.id})">
            <img src="${sig.data}" alt="Signature">
            <button class="delete-saved-sig" onclick="event.stopPropagation(); deleteSignature(${sig.id})">×</button>
        </div>
    `).join('');
}

window.useSignature = function(sigId) {
    const signatures = JSON.parse(localStorage.getItem('signatures') || '[]');
    const signature = signatures.find(s => s.id === sigId);
    if (signature) {
        state.currentSignatureData = signature.data;
        closeSignatureModal();
        alert('Signature selected! Draw a signature field to place it.');
    }
};

window.deleteSignature = function(sigId) {
    if (confirm('Delete this signature?')) {
        let signatures = JSON.parse(localStorage.getItem('signatures') || '[]');
        signatures = signatures.filter(s => s.id !== sigId);
        localStorage.setItem('signatures', JSON.stringify(signatures));
        loadSavedSignatures();
    }
};

// PDF Export
async function downloadFillablePDF() {
    if (!state.pdfBytes) {
        alert('Please load a PDF first.');
        return;
    }

    try {
        const pdfDoc = await PDFLib.PDFDocument.load(state.pdfBytes);
        const form = pdfDoc.getForm();

        // Get font
        const helveticaFont = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
        const timesFont = await pdfDoc.embedFont(PDFLib.StandardFonts.TimesRoman);
        const courierFont = await pdfDoc.embedFont(PDFLib.StandardFonts.Courier);

        // Process each field
        for (const field of state.fields) {
            if (field.type === 'indicator') {
                // Add indicator as text annotation
                const pages = pdfDoc.getPages();
                const page = pages[field.page - 1];
                const { height } = page.getSize();

                // Get current scale
                const currentPage = await state.pdfDoc.getPage(field.page);
                const viewport = currentPage.getViewport({ scale: state.zoom });
                const scaleX = page.getWidth() / viewport.width;
                const scaleY = page.getHeight() / viewport.height;

                page.drawText(field.symbol, {
                    x: field.x * scaleX,
                    y: height - (field.y * scaleY) - (field.size || 24) * scaleY,
                    size: (field.size || 24) * scaleY,
                    font: helveticaFont,
                    color: PDFLib.rgb(
                        parseInt(field.color.slice(1, 3), 16) / 255,
                        parseInt(field.color.slice(3, 5), 16) / 255,
                        parseInt(field.color.slice(5, 7), 16) / 255
                    )
                });
                continue;
            }

            const pages = pdfDoc.getPages();
            const page = pages[field.page - 1];
            const { height } = page.getSize();

            // Calculate scale
            const currentPage = await state.pdfDoc.getPage(field.page);
            const viewport = currentPage.getViewport({ scale: state.zoom });
            const scaleX = page.getWidth() / viewport.width;
            const scaleY = page.getHeight() / viewport.height;

            // Scale field coordinates
            const x = field.x * scaleX;
            const y = height - (field.y * scaleY) - (field.height * scaleY);
            const width = field.width * scaleX;
            const fieldHeight = field.height * scaleY;

            const fieldName = field.name || `${field.type}_${field.id}`;

            try {
                if (field.type === 'text') {
                    const textField = form.createTextField(fieldName);
                    textField.addToPage(page, {
                        x: x,
                        y: y,
                        width: width,
                        height: fieldHeight
                    });

                    const font = field.fontFamily === 'Times-Roman' ? timesFont :
                                 field.fontFamily === 'Courier' ? courierFont : helveticaFont;

                    textField.updateAppearances(font);
                    textField.enableMultiline();

                    if (field.required) {
                        textField.enableRequired();
                    }
                } else if (field.type === 'checkbox') {
                    const checkBox = form.createCheckBox(fieldName);
                    checkBox.addToPage(page, {
                        x: x,
                        y: y,
                        width: Math.min(width, fieldHeight),
                        height: Math.min(width, fieldHeight)
                    });

                    if (field.required) {
                        checkBox.enableRequired();
                    }
                } else if (field.type === 'signature') {
                    const sigField = form.createTextField(fieldName + '_signature');
                    sigField.addToPage(page, {
                        x: x,
                        y: y,
                        width: width,
                        height: fieldHeight
                    });

                    sigField.updateAppearances(helveticaFont);
                    sigField.enableMultiline();
                    sigField.setFontSize(field.fontSize * scaleY);

                    if (field.required) {
                        sigField.enableRequired();
                    }

                    // Add signature image if available
                    if (state.currentSignatureData) {
                        try {
                            const signatureImageBytes = await fetch(state.currentSignatureData).then(res => res.arrayBuffer());
                            const signatureImage = await pdfDoc.embedPng(signatureImageBytes);

                            const sigDims = signatureImage.scale(Math.min(
                                width / signatureImage.width,
                                fieldHeight / signatureImage.height
                            ));

                            page.drawImage(signatureImage, {
                                x: x + (width - sigDims.width) / 2,
                                y: y + (fieldHeight - sigDims.height) / 2,
                                width: sigDims.width,
                                height: sigDims.height,
                                opacity: 0.3
                            });
                        } catch (e) {
                            console.warn('Could not embed signature image:', e);
                        }
                    }
                }
            } catch (error) {
                console.error(`Error creating field ${fieldName}:`, error);
            }
        }

        // Save the PDF
        const pdfBytes = await pdfDoc.save();
        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = 'fillable-form.pdf';
        a.click();

        URL.revokeObjectURL(url);

        alert('Fillable PDF downloaded successfully!');
    } catch (error) {
        console.error('Error creating fillable PDF:', error);
        alert('Error creating fillable PDF. Please try again.');
    }
}

// Reset application
function resetApp() {
    if (confirm('Start with a new PDF? All current fields will be lost.')) {
        state.pdfDoc = null;
        state.pdfBytes = null;
        state.fields = [];
        state.currentPage = 1;
        state.totalPages = 0;
        state.zoom = 1;
        state.selectedField = null;
        state.currentTool = null;

        elements.editorSection.style.display = 'none';
        elements.uploadSection.style.display = 'flex';
        elements.pdfInput.value = '';

        deselectField();
    }
}

// Initialize the app
init();
