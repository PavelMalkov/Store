const express = require('express');
const cors = require('cors');
const { Server } = require('@tus/server');
const { FileStore } = require('@tus/file-store');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());

// Body parsing для JSON API (но не для TUS - TUS обрабатывает тело сам)
app.use('/api', express.json());

// Создаем директорию для загрузок, если её нет
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Настройка TUS сервера
const tusServer = new Server({
  path: '/files',
  datastore: new FileStore({
    directory: uploadsDir,
  }),
  namingFunction: (req) => {
    // Используем оригинальное имя файла из заголовка
    const metadata = req.headers['upload-metadata'];
    if (metadata) {
      const metadataObj = {};
      metadata.split(',').forEach(item => {
        const [key, value] = item.split(' ');
        metadataObj[key] = Buffer.from(value, 'base64').toString('utf-8');
      });
      return metadataObj.filename || `file-${Date.now()}`;
    }
    return `file-${Date.now()}`;
  },
});

// Обработка TUS запросов - используем app.use для обработки всех запросов к /files
app.use('/files', async (req, res) => {
  try {
    console.log(`TUS request: ${req.method} ${req.path} ${req.url}`);
    
    // Вызываем TUS сервер - он сам управляет ответом
    await tusServer.handle(req, res);
    
    // Если ответ не был отправлен, значит TUS не обработал запрос
    if (!res.headersSent) {
      console.warn('TUS did not handle the request, sending 404');
      res.status(404).json({ error: 'Not found' });
    }
  } catch (error) {
    console.error('TUS error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error', details: error.message });
    }
  }
});

// API для получения списка файлов
app.get('/api/files', (req, res) => {
  try {
    const files = fs.readdirSync(uploadsDir)
      .filter(file => {
        const filePath = path.join(uploadsDir, file);
        
        // Исключаем служебные файлы TUS (метаданные)
        // TUS создает файлы с расширением .info или .json для хранения метаданных загрузки
        // Эти файлы необходимы для возобновления прерванных загрузок
        
        // Скрываем файлы .info
        if (file.endsWith('.info')) {
          return false;
        }
        
        // Скрываем файлы .json, если существует файл с таким же именем без .json
        // Например: rufus-4.3.exe.json скрываем, если есть rufus-4.3.exe
        if (file.endsWith('.json')) {
          const baseFileName = file.slice(0, -5); // Убираем .json
          const baseFilePath = path.join(uploadsDir, baseFileName);
          if (fs.existsSync(baseFilePath) && fs.statSync(baseFilePath).isFile()) {
            return false; // Это метаданные TUS для существующего файла
          }
        }
        
        // Проверяем, что это файл, а не директория
        return fs.statSync(filePath).isFile();
      })
      .map(file => {
        const filePath = path.join(uploadsDir, file);
        const stats = fs.statSync(filePath);
        return {
          name: file,
          size: stats.size,
          uploadedAt: stats.mtime,
          url: `/api/files/${encodeURIComponent(file)}`
        };
      });
    
    res.json(files);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API для скачивания файлов
app.get('/api/files/:filename', (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const filePath = path.join(uploadsDir, filename);
    
    // Проверяем существование файла
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    // Устанавливаем заголовки для скачивания
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    
    // Отправляем файл
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API для удаления файлов
app.delete('/api/files/:filename', (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const filePath = path.join(uploadsDir, filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    // Удаляем сам файл
    fs.unlinkSync(filePath);
    
    // Удаляем связанные метаданные TUS (если есть)
    // Проверяем .info файл
    const metadataInfoPath = filePath + '.info';
    if (fs.existsSync(metadataInfoPath)) {
      fs.unlinkSync(metadataInfoPath);
    }
    
    // Проверяем .json файл (метаданные TUS)
    const metadataJsonPath = filePath + '.json';
    console.log(metadataJsonPath);
    if (fs.existsSync(metadataJsonPath)) {
      fs.unlinkSync(metadataJsonPath);
    }
    
    res.json({ message: 'File deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Статические файлы
app.use(express.static('public'));

// Запуск сервера
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(`TUS upload endpoint: http://localhost:${PORT}/files`);
  console.log(`Files directory: ${uploadsDir}`);
});

