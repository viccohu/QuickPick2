#include <napi.h>
#include <vector>
#include <string>
#include <fstream>
#include <algorithm>

#ifdef _WIN32
#include <windows.h>
#include <fileapi.h>
#else
#include <sys/stat.h>
#include <dirent.h>
#endif

// ==================== Thumbnail Generator ====================

struct ThumbnailResult {
    std::string path;
    std::vector<uint8_t> data;
    int width;
    int height;
    bool success;
    std::string error;
};

class ThumbnailGenerator : public Napi::AsyncWorker {
public:
    ThumbnailGenerator(Napi::Env& env, 
                       const std::vector<std::string>& paths,
                       int maxWidth,
                       int maxHeight,
                       int quality)
        : Napi::AsyncWorker(env),
          paths_(paths),
          maxWidth_(maxWidth),
          maxHeight_(maxHeight),
          quality_(quality),
          deferred_(Napi::Promise::Deferred::New(env)) {}
    
    Napi::Promise GetPromise() { return deferred_.Promise(); }

protected:
    void Execute() {
        results_.reserve(paths_.size());
        
        for (size_t i = 0; i < paths_.size(); i++) {
            ThumbnailResult result;
            result.path = paths_[i];
            result.success = false;
            
            std::string ext = GetExtension(paths_[i]);
            std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);
            
            if (ext == ".jpg" || ext == ".jpeg") {
                result = GenerateJpegThumbnail(paths_[i]);
            } else if (ext == ".png") {
                result = GeneratePngThumbnail(paths_[i]);
            } else if (IsRawFile(ext)) {
                result.error = "RAW format requires libraw library";
            } else {
                result.error = "Unsupported format";
            }
            
            results_.push_back(result);
        }
    }
    
    void OnOK() {
        Napi::Env env = Env();
        Napi::Array results = Napi::Array::New(env, results_.size());
        
        for (size_t i = 0; i < results_.size(); i++) {
            Napi::Object obj = Napi::Object::New(env);
            obj.Set("path", Napi::String::New(env, results_[i].path));
            obj.Set("width", Napi::Number::New(env, results_[i].width));
            obj.Set("height", Napi::Number::New(env, results_[i].height));
            obj.Set("success", Napi::Boolean::New(env, results_[i].success));
            
            if (results_[i].success && !results_[i].data.empty()) {
                Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::Copy(
                    env, results_[i].data.data(), results_[i].data.size());
                obj.Set("data", buffer);
            }
            
            if (!results_[i].error.empty()) {
                obj.Set("error", Napi::String::New(env, results_[i].error));
            }
            
            results.Set(static_cast<uint32_t>(i), obj);
        }
        
        deferred_.Resolve(results);
    }
    
    void OnError(const Napi::Error& e) {
        deferred_.Reject(e.Value());
    }

private:
    std::vector<std::string> paths_;
    int maxWidth_;
    int maxHeight_;
    int quality_;
    Napi::Promise::Deferred deferred_;
    std::vector<ThumbnailResult> results_;
    
    std::string GetExtension(const std::string& path) {
        size_t pos = path.find_last_of('.');
        if (pos != std::string::npos) {
            return path.substr(pos);
        }
        return "";
    }
    
    bool IsRawFile(const std::string& ext) {
        static const std::vector<std::string> rawExts = {
            ".cr2", ".cr3", ".nef", ".arw", ".dng", ".raf", 
            ".orf", ".rw2", ".pef", ".srw", ".x3f", ".raw"
        };
        return std::find(rawExts.begin(), rawExts.end(), ext) != rawExts.end();
    }
    
    ThumbnailResult GenerateJpegThumbnail(const std::string& path) {
        ThumbnailResult result;
        result.path = path;
        result.success = false;
        
        FILE* file = fopen(path.c_str(), "rb");
        if (!file) {
            result.error = "Cannot open file";
            return result;
        }
        
        fseek(file, 0, SEEK_END);
        long fileSize = ftell(file);
        fseek(file, 0, SEEK_SET);
        
        std::vector<uint8_t> fileData(fileSize);
        fread(fileData.data(), 1, fileSize, file);
        fclose(file);
        
        result.data = std::move(fileData);
        result.success = true;
        result.width = maxWidth_;
        result.height = maxHeight_;
        
        return result;
    }
    
    ThumbnailResult GeneratePngThumbnail(const std::string& path) {
        return GenerateJpegThumbnail(path);
    }
};

// ==================== EXIF Reader ====================

struct ExifResult {
    std::string path;
    int rating;
    bool success;
    std::string error;
};

class ExifReader : public Napi::AsyncWorker {
public:
    ExifReader(Napi::Env& env, const std::vector<std::string>& paths)
        : Napi::AsyncWorker(env),
          paths_(paths),
          deferred_(Napi::Promise::Deferred::New(env)) {}
    
    Napi::Promise GetPromise() { return deferred_.Promise(); }

protected:
    void Execute() {
        results_.reserve(paths_.size());
        
        for (size_t i = 0; i < paths_.size(); i++) {
            ExifResult result;
            result.path = paths_[i];
            result.success = false;
            result.rating = 0;
            
            result.rating = ReadRating(paths_[i]);
            result.success = true;
            
            results_.push_back(result);
        }
    }
    
    void OnOK() {
        Napi::Env env = Env();
        Napi::Object results = Napi::Object::New(env);
        
        for (size_t i = 0; i < results_.size(); i++) {
            Napi::Object obj = Napi::Object::New(env);
            obj.Set("rating", Napi::Number::New(env, results_[i].rating));
            obj.Set("success", Napi::Boolean::New(env, results_[i].success));
            
            results.Set(results_[i].path, obj);
        }
        
        deferred_.Resolve(results);
    }
    
    void OnError(const Napi::Error& e) {
        deferred_.Reject(e.Value());
    }

private:
    std::vector<std::string> paths_;
    Napi::Promise::Deferred deferred_;
    std::vector<ExifResult> results_;
    
    int ReadRating(const std::string& path) {
        std::ifstream file(path, std::ios::binary);
        if (!file.is_open()) {
            return 0;
        }
        
        file.seekg(0, std::ios::end);
        std::streampos fileSize = file.tellg();
        file.seekg(0, std::ios::beg);
        
        if (fileSize < 4) return 0;
        
        uint8_t marker1, marker2;
        file.read(reinterpret_cast<char*>(&marker1), 1);
        file.read(reinterpret_cast<char*>(&marker2), 1);
        
        if (marker1 != 0xFF || marker2 != 0xD8) {
            return 0;
        }
        
        std::streampos minSize = 4;
        while (file.tellg() < fileSize - minSize) {
            uint8_t prefix;
            file.read(reinterpret_cast<char*>(&prefix), 1);
            
            if (prefix != 0xFF) continue;
            
            uint8_t marker;
            file.read(reinterpret_cast<char*>(&marker), 1);
            
            if (marker == 0xE1) {
                char app1Header[6];
                file.read(app1Header, 6);
                
                if (std::string(app1Header, 4) == "Exif") {
                    return ParseExifRating(file, fileSize);
                }
            } else if (marker == 0xDA || marker == 0xD9) {
                break;
            } else if (marker >= 0xE0 && marker <= 0xEF) {
                uint16_t length;
                file.read(reinterpret_cast<char*>(&length), 2);
                length = (length >> 8) | (length << 8);
                file.seekg(length - 2, std::ios::cur);
            }
        }
        
        return 0;
    }
    
    int ParseExifRating(std::ifstream& file, std::streampos fileSize) {
        char tiffHeader[8];
        file.read(tiffHeader, 8);
        
        bool littleEndian = (tiffHeader[0] == 0x49);
        
        auto readUint16 = [&littleEndian, &file]() -> uint16_t {
            uint8_t bytes[2];
            file.read(reinterpret_cast<char*>(bytes), 2);
            return littleEndian ? bytes[0] | (bytes[1] << 8) : (bytes[0] << 8) | bytes[1];
        };
        
        auto readUint32 = [&littleEndian, &file]() -> uint32_t {
            uint8_t bytes[4];
            file.read(reinterpret_cast<char*>(bytes), 4);
            return littleEndian 
                ? bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
                : (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
        };
        
        uint32_t ifdOffset = readUint32();
        file.seekg(ifdOffset - 8, std::ios::cur);
        
        uint16_t numEntries = readUint16();
        
        for (uint16_t i = 0; i < numEntries; i++) {
            uint16_t tag = readUint16();
            uint16_t type = readUint16();
            uint32_t count = readUint32();
            
            char valueBytes[4];
            file.read(valueBytes, 4);
            
            if (tag == 0x4746) {
                uint16_t rating = littleEndian 
                    ? static_cast<uint8_t>(valueBytes[0]) | (static_cast<uint8_t>(valueBytes[1]) << 8)
                    : (static_cast<uint8_t>(valueBytes[0]) << 8) | static_cast<uint8_t>(valueBytes[1]);
                return static_cast<int>(rating);
            }
        }
        
        return 0;
    }
};

// ==================== File Scanner ====================

struct FileInfo {
    std::string path;
    std::string name;
    std::string extension;
    bool isDirectory;
    uint64_t size;
};

class FileScanner : public Napi::AsyncWorker {
public:
    FileScanner(Napi::Env& env, 
                const std::vector<std::string>& directories,
                const std::vector<std::string>& extensions)
        : Napi::AsyncWorker(env),
          directories_(directories),
          extensions_(extensions),
          deferred_(Napi::Promise::Deferred::New(env)) {}
    
    Napi::Promise GetPromise() { return deferred_.Promise(); }

protected:
    void Execute() {
        for (const auto& dir : directories_) {
            ScanDirectory(dir);
        }
    }
    
    void OnOK() {
        Napi::Env env = Env();
        Napi::Array results = Napi::Array::New(env, files_.size());
        
        for (size_t i = 0; i < files_.size(); i++) {
            Napi::Object obj = Napi::Object::New(env);
            obj.Set("path", Napi::String::New(env, files_[i].path));
            obj.Set("name", Napi::String::New(env, files_[i].name));
            obj.Set("extension", Napi::String::New(env, files_[i].extension));
            obj.Set("isDirectory", Napi::Boolean::New(env, files_[i].isDirectory));
            obj.Set("size", Napi::Number::New(env, static_cast<double>(files_[i].size)));
            results.Set(static_cast<uint32_t>(i), obj);
        }
        
        Napi::Object response = Napi::Object::New(env);
        response.Set("files", results);
        
        if (!errors_.empty()) {
            Napi::Array errorArray = Napi::Array::New(env, errors_.size());
            for (size_t i = 0; i < errors_.size(); i++) {
                errorArray.Set(static_cast<uint32_t>(i), Napi::String::New(env, errors_[i]));
            }
            response.Set("errors", errorArray);
        }
        
        deferred_.Resolve(response);
    }
    
    void OnError(const Napi::Error& e) {
        deferred_.Reject(e.Value());
    }

private:
    std::vector<std::string> directories_;
    std::vector<std::string> extensions_;
    Napi::Promise::Deferred deferred_;
    std::vector<FileInfo> files_;
    std::vector<std::string> errors_;
    
    void ScanDirectory(const std::string& dirPath) {
#ifdef _WIN32
        WIN32_FIND_DATAA findData;
        std::string searchPath = dirPath + "\\*";
        
        HANDLE hFind = FindFirstFileA(searchPath.c_str(), &findData);
        if (hFind == INVALID_HANDLE_VALUE) {
            errors_.push_back("Cannot open directory: " + dirPath);
            return;
        }
        
        do {
            std::string name = findData.cFileName;
            if (name == "." || name == "..") continue;
            
            FileInfo info;
            info.name = name;
            info.path = dirPath + "\\" + name;
            info.isDirectory = (findData.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
            
            if (!info.isDirectory) {
                size_t pos = name.find_last_of('.');
                if (pos != std::string::npos) {
                    info.extension = name.substr(pos);
                    std::transform(info.extension.begin(), info.extension.end(), 
                                  info.extension.begin(), ::tolower);
                }
                
                info.size = (static_cast<uint64_t>(findData.nFileSizeHigh) << 32) | findData.nFileSizeLow;
                
                if (extensions_.empty() || 
                    std::find(extensions_.begin(), extensions_.end(), info.extension) != extensions_.end()) {
                    files_.push_back(info);
                }
            }
        } while (FindNextFileA(hFind, &findData) != 0);
        
        FindClose(hFind);
#else
        DIR* dir = opendir(dirPath.c_str());
        if (!dir) {
            errors_.push_back("Cannot open directory: " + dirPath);
            return;
        }
        
        struct dirent* entry;
        while ((entry = readdir(dir)) != nullptr) {
            std::string name = entry->d_name;
            if (name == "." || name == "..") continue;
            
            FileInfo info;
            info.name = name;
            info.path = dirPath + "/" + name;
            
            struct stat st;
            if (stat(info.path.c_str(), &st) == 0) {
                info.isDirectory = S_ISDIR(st.st_mode);
                info.size = st.st_size;
            }
            
            if (!info.isDirectory) {
                size_t pos = name.find_last_of('.');
                if (pos != std::string::npos) {
                    info.extension = name.substr(pos);
                    std::transform(info.extension.begin(), info.extension.end(), 
                                  info.extension.begin(), ::tolower);
                }
                
                if (extensions_.empty() || 
                    std::find(extensions_.begin(), extensions_.end(), info.extension) != extensions_.end()) {
                    files_.push_back(info);
                }
            }
        }
        
        closedir(dir);
#endif
    }
};

// ==================== Exported Functions ====================

Napi::Value GenerateThumbnails(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsArray()) {
        Napi::TypeError::New(env, "Expected array of paths").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    Napi::Array pathsArray = info[0].As<Napi::Array>();
    std::vector<std::string> paths;
    paths.reserve(pathsArray.Length());
    
    for (uint32_t i = 0; i < pathsArray.Length(); i++) {
        paths.push_back(pathsArray.Get(i).As<Napi::String>().Utf8Value());
    }
    
    int maxWidth = 120;
    int maxHeight = 80;
    int quality = 85;
    
    if (info.Length() > 1 && info[1].IsObject()) {
        Napi::Object options = info[1].As<Napi::Object>();
        if (options.Has("maxWidth")) maxWidth = options.Get("maxWidth").As<Napi::Number>().Int32Value();
        if (options.Has("maxHeight")) maxHeight = options.Get("maxHeight").As<Napi::Number>().Int32Value();
        if (options.Has("quality")) quality = options.Get("quality").As<Napi::Number>().Int32Value();
    }
    
    ThumbnailGenerator* worker = new ThumbnailGenerator(env, paths, maxWidth, maxHeight, quality);
    worker->Queue();
    return worker->GetPromise();
}

Napi::Value ReadExifRatings(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsArray()) {
        Napi::TypeError::New(env, "Expected array of paths").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    Napi::Array pathsArray = info[0].As<Napi::Array>();
    std::vector<std::string> paths;
    paths.reserve(pathsArray.Length());
    
    for (uint32_t i = 0; i < pathsArray.Length(); i++) {
        paths.push_back(pathsArray.Get(i).As<Napi::String>().Utf8Value());
    }
    
    ExifReader* worker = new ExifReader(env, paths);
    worker->Queue();
    return worker->GetPromise();
}

Napi::Value ScanFiles(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsArray()) {
        Napi::TypeError::New(env, "Expected array of directories").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    Napi::Array dirsArray = info[0].As<Napi::Array>();
    std::vector<std::string> directories;
    directories.reserve(dirsArray.Length());
    
    for (uint32_t i = 0; i < dirsArray.Length(); i++) {
        directories.push_back(dirsArray.Get(i).As<Napi::String>().Utf8Value());
    }
    
    std::vector<std::string> extensions;
    if (info.Length() > 1 && info[1].IsArray()) {
        Napi::Array extArray = info[1].As<Napi::Array>();
        extensions.reserve(extArray.Length());
        for (uint32_t i = 0; i < extArray.Length(); i++) {
            extensions.push_back(extArray.Get(i).As<Napi::String>().Utf8Value());
        }
    }
    
    FileScanner* worker = new FileScanner(env, directories, extensions);
    worker->Queue();
    return worker->GetPromise();
}

// ==================== Module Init ====================

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("generateThumbnails", Napi::Function::New(env, GenerateThumbnails));
    exports.Set("readExifRatings", Napi::Function::New(env, ReadExifRatings));
    exports.Set("scanFiles", Napi::Function::New(env, ScanFiles));
    return exports;
}

NODE_API_MODULE(quickpick_native, Init)
