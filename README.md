# PDF Form Builder

A powerful web application that allows users to upload PDFs and convert them into fillable forms with customizable form fields, signature areas, checkboxes, and indicator symbols.

## Features

### Form Field Types
- **Text Fields**: Add editable text input fields anywhere on the PDF
- **Checkboxes**: Insert interactive checkboxes for selections
- **Signature Fields**: Create designated areas for signatures
- **Indicator Symbols**: Add visual indicators including:
  - ✓ Checkmarks
  - ✗ Cross marks
  - → Arrows
  - ★ Stars
  - ❗ Alert/Exclamation marks

### Field Customization
Each form field can be customized with:
- **Size**: Adjustable width and height
- **Colors**:
  - Text color
  - Background color
  - Border color
- **Font**:
  - Font family (Helvetica, Times Roman, Courier)
  - Font size
- **Border**: Adjustable border width
- **Field Name**: Custom naming for form fields

### Signature Management
- **Draw Signatures**: Create signatures using mouse or touch input
- **Save Signatures**: Store multiple signatures in browser cache (localStorage)
- **Reuse Signatures**: Quickly apply saved signatures to documents
- **Signature Library**: View and manage all saved signatures

### Multi-Page Support
- Navigate through multi-page PDFs
- Add form fields to any page
- Page-by-page field management

### User Experience
- Drag-and-drop field positioning
- Real-time property editing
- Visual field selection and highlighting
- Responsive design for various screen sizes
- Clean, modern interface

## Technologies Used

- **HTML5/CSS3**: Modern web standards
- **JavaScript (ES6+)**: Application logic
- **PDF.js**: PDF rendering in the browser
- **PDF-lib**: PDF manipulation and form field creation
- **LocalStorage API**: Signature caching

## How to Use

### 1. Upload a PDF
Click the "Upload PDF" button and select a PDF file from your computer.

### 2. Add Form Fields
1. Click on any tool button (Text Field, Checkbox, Signature, etc.)
2. Click on the PDF where you want to place the field
3. The field will appear on the PDF

### 3. Customize Fields
1. Click on any field to select it
2. Use the Properties Panel on the right to adjust:
   - Size (width/height)
   - Colors
   - Font settings
   - Border properties
   - Field name

### 4. Move Fields
Click and drag any field to reposition it on the PDF.

### 5. Create & Save Signatures
1. Click "Create Signature" button
2. Draw your signature using mouse or touch
3. Click "Save Signature" to store it
4. Access saved signatures via "Saved Signatures" button

### 6. Add Indicator Symbols
Click on any indicator button (Checkmark, Cross, Arrow, Star, Alert) and place it on the PDF.

### 7. Export Fillable PDF
Click "Download PDF" to export your PDF with all form fields embedded.

## Installation

### Option 1: Local Development
1. Clone or download this repository
2. Open `index.html` in a modern web browser
3. No build process or dependencies required!

### Option 2: Web Server
```bash
# Using Python
python -m http.server 8000

# Using Node.js
npx http-server

# Using PHP
php -S localhost:8000
```

Then navigate to `http://localhost:8000` in your browser.

## Browser Support

This application works best in modern browsers:
- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Opera 76+

## File Structure

```
pdf-form-builder/
├── index.html          # Main HTML file
├── styles.css          # Styling and layout
├── app.js             # Application logic
└── README.md          # Documentation
```

## Key Features Explained

### PDF Rendering
Uses PDF.js to render PDF pages directly in the browser canvas, allowing for accurate field placement.

### Form Field Creation
Leverages PDF-lib to create actual PDF form fields that are embedded in the output PDF, making them truly fillable in any PDF reader.

### Signature Storage
Signatures are stored as base64-encoded images in the browser's localStorage, persisting across sessions without requiring a backend.

### Responsive Design
The interface adapts to different screen sizes with a grid layout that collapses on smaller devices.

## Security & Privacy

- All processing happens in the browser - no data is sent to any server
- Signatures are stored locally in your browser's cache
- No external API calls (except for loading PDF.js and PDF-lib libraries from CDN)
- Your PDFs and data remain completely private

## Limitations

- Maximum PDF size depends on browser memory
- Signature storage is limited by localStorage (typically 5-10MB)
- Complex PDF features may not be preserved
- Some advanced PDF features may not be fully supported

## Future Enhancements

Potential features for future versions:
- Radio button support
- Dropdown/combo box fields
- Date picker fields
- Multi-line text areas
- Field validation rules
- Template saving/loading
- Cloud storage integration
- Collaborative editing

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

This project is open source and available under the MIT License.

## Support

For issues, questions, or contributions, please open an issue on the repository.

---

Made with ❤️ for making PDFs fillable and accessible
