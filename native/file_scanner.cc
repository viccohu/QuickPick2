#include <napi.h>
#include <vector>
#include <string>
#include <algorithm>

#ifdef _WIN32
#include <windows.h>
#include <fileapi.h>
#else
#include <sys/stat.h>
#include <dirent.h>
#endif

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

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("scanFiles", Napi::Function::New(env, ScanFiles));
    return exports;
}

NODE_API_MODULE(file_scanner, Init)
