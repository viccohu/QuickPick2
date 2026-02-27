#include <napi.h>
#include <windows.h>
#include <wincodec.h>
#include <wincodecsdk.h>
#include <string>
#include <vector>
#include <unordered_map>
#include <list>
#include <mutex>
#include <thread>
#include <atomic>
#include <condition_variable>

#pragma comment(lib, "windowscodecs.lib")

static IWICImagingFactory* g_pWICFactory = nullptr;
static bool g_wicInitialized = false;
static std::mutex g_wicMutex;

struct CacheItem {
    std::vector<uint8_t> data;
    int width;
    int height;
};

static std::unordered_map<std::wstring, CacheItem> g_cache;
static std::list<std::wstring> g_lru;
static std::mutex g_cacheMutex;
static const int MAX_CACHE = 20;

static std::vector<std::wstring> g_fileList;
static std::wstring g_currentFile;
static std::thread g_preloadThread;
static std::atomic<bool> g_preloadRunning(false);
static std::condition_variable g_preloadCV;
static std::mutex g_preloadMutex;

static bool InitWIC() {
    std::lock_guard<std::mutex> lock(g_wicMutex);
    if (g_wicInitialized) return true;
    
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
        return false;
    }
    
    hr = CoCreateInstance(
        CLSID_WICImagingFactory,
        nullptr,
        CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(&g_pWICFactory)
    );
    
    if (SUCCEEDED(hr)) {
        g_wicInitialized = true;
        return true;
    }
    return false;
}

static void UninitWIC() {
    std::lock_guard<std::mutex> lock(g_wicMutex);
    if (g_pWICFactory) {
        g_pWICFactory->Release();
        g_pWICFactory = nullptr;
    }
    g_wicInitialized = false;
}

static std::wstring Utf8ToWide(const std::string& str) {
    if (str.empty()) return std::wstring();
    int size = MultiByteToWideChar(CP_UTF8, 0, str.c_str(), -1, nullptr, 0);
    std::wstring result(size - 1, 0);
    MultiByteToWideChar(CP_UTF8, 0, str.c_str(), -1, &result[0], size);
    return result;
}

static bool EncodeBitmapToJPEG(IWICBitmap* pBitmap, std::vector<uint8_t>& outData) {
    if (!pBitmap || !g_pWICFactory) {
        printf("[WIC] EncodeBitmapToJPEG: Invalid params\n");
        return false;
    }
    
    UINT w, h;
    pBitmap->GetSize(&w, &h);
    printf("[WIC] EncodeBitmapToJPEG: %u x %u\n", w, h);
    
    IStream* pMemoryStream = nullptr;
    IWICBitmapEncoder* pEncoder = nullptr;
    IWICBitmapFrameEncode* pFrame = nullptr;
    IPropertyBag2* pPropertyBag = nullptr;
    
    HRESULT hr = CreateStreamOnHGlobal(nullptr, TRUE, &pMemoryStream);
    if (FAILED(hr)) {
        printf("[WIC] CreateStreamOnHGlobal failed: 0x%08X\n", hr);
        return false;
    }
    
    hr = g_pWICFactory->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &pEncoder);
    if (FAILED(hr)) {
        printf("[WIC] CreateEncoder failed: 0x%08X\n", hr);
        pMemoryStream->Release();
        return false;
    }
    
    hr = pEncoder->Initialize(pMemoryStream, WICBitmapEncoderNoCache);
    if (FAILED(hr)) {
        printf("[WIC] Encoder Initialize failed: 0x%08X\n", hr);
        pEncoder->Release();
        pMemoryStream->Release();
        return false;
    }
    
    hr = pEncoder->CreateNewFrame(&pFrame, &pPropertyBag);
    if (FAILED(hr)) {
        printf("[WIC] CreateNewFrame failed: 0x%08X\n", hr);
        pEncoder->Release();
        pMemoryStream->Release();
        return false;
    }
    
    PROPBAG2 option = {0};
    option.pstrName = (LPOLESTR)L"ImageQuality";
    VARIANT value;
    VariantInit(&value);
    value.vt = VT_R4;
    value.fltVal = 0.9f;
    hr = pPropertyBag->Write(1, &option, &value);
    pPropertyBag->Release();
    VariantClear(&value);
    
    hr = pFrame->Initialize(nullptr);
    if (FAILED(hr)) {
        printf("[WIC] Frame Initialize failed: 0x%08X\n", hr);
        pFrame->Release();
        pEncoder->Release();
        pMemoryStream->Release();
        return false;
    }
    
    UINT width, height;
    pBitmap->GetSize(&width, &height);
    pFrame->SetSize(width, height);
    
    WICPixelFormatGUID format = GUID_WICPixelFormat24bppBGR;
    hr = pFrame->SetPixelFormat(&format);
    if (FAILED(hr)) {
        printf("[WIC] SetPixelFormat failed: 0x%08X\n", hr);
    }
    
    hr = pFrame->WriteSource(pBitmap, nullptr);
    if (FAILED(hr)) {
        printf("[WIC] WriteSource failed: 0x%08X\n", hr);
        pFrame->Release();
        pEncoder->Release();
        pMemoryStream->Release();
        return false;
    }
    
    hr = pFrame->Commit();
    if (FAILED(hr)) {
        printf("[WIC] Frame Commit failed: 0x%08X\n", hr);
        pFrame->Release();
        pEncoder->Release();
        pMemoryStream->Release();
        return false;
    }
    pFrame->Release();
    
    hr = pEncoder->Commit();
    if (FAILED(hr)) {
        printf("[WIC] Encoder Commit failed: 0x%08X\n", hr);
        pEncoder->Release();
        pMemoryStream->Release();
        return false;
    }
    pEncoder->Release();
    
    STATSTG stat;
    hr = pMemoryStream->Stat(&stat, STATFLAG_DEFAULT);
    if (SUCCEEDED(hr)) {
        ULARGE_INTEGER size = stat.cbSize;
        outData.resize((size_t)size.QuadPart);
        
        LARGE_INTEGER pos = {0};
        pMemoryStream->Seek(pos, STREAM_SEEK_SET, nullptr);
        
        ULONG bytesRead = 0;
        hr = pMemoryStream->Read(outData.data(), (ULONG)size.QuadPart, &bytesRead);
        
        if (SUCCEEDED(hr) && bytesRead > 0) {
            printf("[WIC] JPEG encode success: %lu bytes\n", bytesRead);
            pMemoryStream->Release();
            return true;
        }
        printf("[WIC] Stream Read failed: 0x%08X, bytesRead: %lu\n", hr, bytesRead);
    }
    
    pMemoryStream->Release();
    return false;
}

static bool ExtractEmbeddedJPEG(const std::wstring& filePath, std::vector<uint8_t>& outData, int& outWidth, int& outHeight) {
    if (!g_pWICFactory) {
        printf("[WIC] ExtractEmbeddedJPEG: WIC factory is null\n");
        return false;
    }
    
    IWICBitmapDecoder* pDecoder = nullptr;
    IWICBitmapFrameDecode* pFrame = nullptr;
    IWICMetadataQueryReader* pMetaReader = nullptr;
    
    HRESULT hr = g_pWICFactory->CreateDecoderFromFilename(
        filePath.c_str(),
        nullptr,
        GENERIC_READ,
        WICDecodeMetadataCacheOnDemand,
        &pDecoder
    );
    
    if (FAILED(hr)) {
        printf("[WIC] ExtractEmbeddedJPEG: CreateDecoder failed: 0x%08X\n", hr);
        return false;
    }
    
    hr = pDecoder->GetFrame(0, &pFrame);
    if (FAILED(hr)) {
        printf("[WIC] ExtractEmbeddedJPEG: GetFrame failed: 0x%08X\n", hr);
        pDecoder->Release();
        return false;
    }
    
    hr = pFrame->GetMetadataQueryReader(&pMetaReader);
    if (FAILED(hr)) {
        printf("[WIC] ExtractEmbeddedJPEG: GetMetadataQueryReader failed: 0x%08X\n", hr);
        pFrame->Release();
        pDecoder->Release();
        return false;
    }
    
    const wchar_t* thumbPaths[] = {
        L"/app1/ifd/thumbnaillength",
        L"/app1/ifd2/thumbnail",
        L"/ifd/thumbnaillength",
        L"/xmp/aux/ThumbnailImage"
    };
    
    bool found = false;
    
    PROPVARIANT propValue;
    PropVariantInit(&propValue);
    
    for (const auto& path : thumbPaths) {
        hr = pMetaReader->GetMetadataByName(path, &propValue);
        if (SUCCEEDED(hr) && propValue.vt == (VT_UI1 | VT_ARRAY)) {
            printf("[WIC] Found embedded thumbnail at: %ws, size: %lu\n", path, propValue.caub.cElems);
            
            IStream* pMemStream = nullptr;
            hr = CreateStreamOnHGlobal(nullptr, TRUE, &pMemStream);
            if (SUCCEEDED(hr)) {
                ULONG written = 0;
                pMemStream->Write(propValue.caub.pElems, propValue.caub.cElems, &written);
                
                LARGE_INTEGER pos = {0};
                pMemStream->Seek(pos, STREAM_SEEK_SET, nullptr);
                
                IWICBitmapDecoder* pThumbDecoder = nullptr;
                hr = g_pWICFactory->CreateDecoderFromStream(
                    pMemStream, nullptr, WICDecodeMetadataCacheOnDemand, &pThumbDecoder);
                
                if (SUCCEEDED(hr)) {
                    IWICBitmapFrameDecode* pThumbFrame = nullptr;
                    hr = pThumbDecoder->GetFrame(0, &pThumbFrame);
                    
                    if (SUCCEEDED(hr)) {
                        UINT w, h;
                        pThumbFrame->GetSize(&w, &h);
                        printf("[WIC] Embedded thumbnail size: %u x %u\n", w, h);
                        
                        outWidth = w;
                        outHeight = h;
                        
                        IWICBitmap* pBitmap = nullptr;
                        hr = g_pWICFactory->CreateBitmapFromSource(pThumbFrame, WICBitmapCacheOnDemand, &pBitmap);
                        
                        if (SUCCEEDED(hr)) {
                            if (EncodeBitmapToJPEG(pBitmap, outData)) {
                                found = true;
                                printf("[WIC] Extracted embedded JPEG: %zu bytes\n", outData.size());
                            }
                            pBitmap->Release();
                        }
                        pThumbFrame->Release();
                    }
                    pThumbDecoder->Release();
                }
                pMemStream->Release();
            }
            
            PropVariantClear(&propValue);
            break;
        }
        PropVariantClear(&propValue);
    }
    
    if (!found) {
        IWICBitmapSource* pThumbnail = nullptr;
        hr = pFrame->GetThumbnail(&pThumbnail);
        if (SUCCEEDED(hr) && pThumbnail) {
            UINT w, h;
            pThumbnail->GetSize(&w, &h);
            printf("[WIC] Found GetThumbnail: %u x %u\n", w, h);
            
            outWidth = w;
            outHeight = h;
            
            IWICBitmap* pBitmap = nullptr;
            hr = g_pWICFactory->CreateBitmapFromSource(pThumbnail, WICBitmapCacheOnDemand, &pBitmap);
            if (SUCCEEDED(hr)) {
                if (EncodeBitmapToJPEG(pBitmap, outData)) {
                    found = true;
                }
                pBitmap->Release();
            }
            pThumbnail->Release();
        }
    }
    
    pMetaReader->Release();
    pFrame->Release();
    pDecoder->Release();
    
    return found;
}

static IWICBitmap* DecodeRAW(const std::wstring& filePath, int maxSize) {
    if (!g_pWICFactory) {
        printf("[WIC] DecodeRAW: WIC factory is null\n");
        return nullptr;
    }
    
    IWICBitmapDecoder* pDecoder = nullptr;
    IWICBitmapFrameDecode* pFrame = nullptr;
    IWICBitmap* pBitmap = nullptr;
    
    HRESULT hr = g_pWICFactory->CreateDecoderFromFilename(
        filePath.c_str(),
        nullptr,
        GENERIC_READ,
        WICDecodeMetadataCacheOnDemand,
        &pDecoder
    );
    
    if (FAILED(hr)) {
        printf("[WIC] CreateDecoderFromFilename failed: 0x%08X, path: %ws\n", hr, filePath.c_str());
        return nullptr;
    }
    
    hr = pDecoder->GetFrame(0, &pFrame);
    if (FAILED(hr)) {
        printf("[WIC] GetFrame failed: 0x%08X\n", hr);
        pDecoder->Release();
        return nullptr;
    }
    
    UINT width, height;
    pFrame->GetSize(&width, &height);
    printf("[WIC] Decoded size: %u x %u\n", width, height);
    
    if (maxSize > 0 && (width > (UINT)maxSize || height > (UINT)maxSize)) {
        IWICBitmapScaler* pScaler = nullptr;
        hr = g_pWICFactory->CreateBitmapScaler(&pScaler);
        if (SUCCEEDED(hr)) {
            double scaleW = (double)maxSize / width;
            double scaleH = (double)maxSize / height;
            double scale = scaleW < scaleH ? scaleW : scaleH;
            UINT newWidth = (UINT)(width * scale);
            UINT newHeight = (UINT)(height * scale);
            
            hr = pScaler->Initialize(pFrame, newWidth, newHeight, WICBitmapInterpolationModeHighQualityCubic);
            if (SUCCEEDED(hr)) {
                hr = g_pWICFactory->CreateBitmapFromSource(pScaler, WICBitmapCacheOnDemand, &pBitmap);
            }
            pScaler->Release();
        }
    } else {
        hr = g_pWICFactory->CreateBitmapFromSource(pFrame, WICBitmapCacheOnDemand, &pBitmap);
    }
    
    pFrame->Release();
    pDecoder->Release();
    
    return pBitmap;
}

static bool GetCachedPreview(const std::wstring& filePath, CacheItem& item) {
    std::lock_guard<std::mutex> lock(g_cacheMutex);
    auto it = g_cache.find(filePath);
    if (it != g_cache.end()) {
        item = it->second;
        g_lru.remove(filePath);
        g_lru.push_front(filePath);
        return true;
    }
    return false;
}

static void AddToCache(const std::wstring& filePath, const CacheItem& item) {
    std::lock_guard<std::mutex> lock(g_cacheMutex);
    g_cache[filePath] = item;
    g_lru.push_front(filePath);
    
    while (g_cache.size() > MAX_CACHE) {
        std::wstring oldKey = g_lru.back();
        g_lru.pop_back();
        g_cache.erase(oldKey);
    }
}

static void PreloadWorker() {
    while (g_preloadRunning) {
        std::wstring currentFile;
        {
            std::lock_guard<std::mutex> lock(g_preloadMutex);
            currentFile = g_currentFile;
        }
        
        if (currentFile.empty() || g_fileList.empty()) {
            std::unique_lock<std::mutex> lock(g_preloadMutex);
            g_preloadCV.wait_for(lock, std::chrono::milliseconds(200));
            continue;
        }
        
        int idx = -1;
        for (int i = 0; i < (int)g_fileList.size(); i++) {
            if (g_fileList[i] == currentFile) {
                idx = i;
                break;
            }
        }
        
        if (idx >= 0) {
            int preload[] = {idx - 1, idx + 1};
            for (int i : preload) {
                if (i >= 0 && i < (int)g_fileList.size()) {
                    std::wstring path = g_fileList[i];
                    CacheItem item;
                    if (!GetCachedPreview(path, item)) {
                        IWICBitmap* pBitmap = DecodeRAW(path, 2000);
                        if (pBitmap) {
                            UINT w, h;
                            pBitmap->GetSize(&w, &h);
                            
                            CacheItem newItem;
                            if (EncodeBitmapToJPEG(pBitmap, newItem.data)) {
                                newItem.width = w;
                                newItem.height = h;
                                AddToCache(path, newItem);
                            }
                            pBitmap->Release();
                        }
                    }
                }
            }
        }
        
        std::unique_lock<std::mutex> lock(g_preloadMutex);
        g_preloadCV.wait_for(lock, std::chrono::milliseconds(500));
    }
}

class WICPreviewWorker : public Napi::AsyncWorker {
public:
    WICPreviewWorker(Napi::Env& env, const std::string& filePath, int maxSize, bool backgroundDecode = false)
        : Napi::AsyncWorker(env),
          filePath_(filePath),
          maxSize_(maxSize),
          backgroundDecode_(backgroundDecode),
          deferred_(Napi::Promise::Deferred::New(env)) {}
    
    Napi::Promise GetPromise() { return deferred_.Promise(); }
    
    bool needsBackgroundDecode() const { return needsBackgroundDecode_; }
    const std::string& getFilePath() const { return filePath_; }
    int getMaxSize() const { return maxSize_; }

protected:
    void Execute() {
        printf("[WIC] WICPreviewWorker::Execute - filePath: %s, maxSize: %d, background: %d\n", 
               filePath_.c_str(), maxSize_, backgroundDecode_);
        
        std::wstring widePath = Utf8ToWide(filePath_);
        
        if (!backgroundDecode_ && GetCachedPreview(widePath, cacheItem_)) {
            fromCache_ = true;
            printf("[WIC] Found in cache\n");
            return;
        }
        
        if (!g_wicInitialized) {
            printf("[WIC] WIC not initialized, initializing...\n");
            if (!InitWIC()) {
                error_ = "WIC not initialized";
                printf("[WIC] WIC init failed\n");
                return;
            }
        }
        
        if (!backgroundDecode_) {
            printf("[WIC] Trying to extract embedded JPEG...\n");
            int embedWidth = 0, embedHeight = 0;
            if (ExtractEmbeddedJPEG(widePath, cacheItem_.data, embedWidth, embedHeight)) {
                cacheItem_.width = embedWidth;
                cacheItem_.height = embedHeight;
                embeddedJpegUsed_ = true;
                
                if (embedWidth >= maxSize_ && embedHeight >= maxSize_) {
                    printf("[WIC] Embedded JPEG is high resolution (%d x %d), using it\n", embedWidth, embedHeight);
                    AddToCache(widePath, cacheItem_);
                    return;
                }
                printf("[WIC] Embedded JPEG is low resolution (%d x %d), need background decode\n", embedWidth, embedHeight);
                needsBackgroundDecode_ = true;
                AddToCache(widePath, cacheItem_);
                return;
            }
        }
        
        printf("[WIC] Calling DecodeRAW...\n");
        IWICBitmap* pBitmap = DecodeRAW(widePath, maxSize_);
        if (!pBitmap) {
            if (!cacheItem_.data.empty()) {
                printf("[WIC] DecodeRAW failed, using low-res embedded JPEG\n");
                return;
            }
            error_ = "Failed to decode RAW";
            printf("[WIC] DecodeRAW returned null\n");
            return;
        }
        
        UINT w, h;
        pBitmap->GetSize(&w, &h);
        printf("[WIC] Bitmap size: %u x %u\n", w, h);
        
        printf("[WIC] Encoding to JPEG...\n");
        if (EncodeBitmapToJPEG(pBitmap, cacheItem_.data)) {
            cacheItem_.width = w;
            cacheItem_.height = h;
            AddToCache(widePath, cacheItem_);
            printf("[WIC] JPEG encode success, size: %zu bytes\n", cacheItem_.data.size());
        } else {
            error_ = "Failed to encode JPEG";
            printf("[WIC] JPEG encode failed\n");
        }
        
        pBitmap->Release();
    }
    
    void OnOK() {
        Napi::Env env = Env();
        Napi::Object obj = Napi::Object::New(env);
        
        if (!error_.empty()) {
            obj.Set("success", Napi::Boolean::New(env, false));
            obj.Set("error", Napi::String::New(env, error_));
        } else {
            obj.Set("success", Napi::Boolean::New(env, true));
            obj.Set("width", Napi::Number::New(env, cacheItem_.width));
            obj.Set("height", Napi::Number::New(env, cacheItem_.height));
            obj.Set("fromCache", Napi::Boolean::New(env, fromCache_));
            obj.Set("embeddedJpeg", Napi::Boolean::New(env, embeddedJpegUsed_));
            obj.Set("needsBackgroundDecode", Napi::Boolean::New(env, needsBackgroundDecode_));
            
            if (!cacheItem_.data.empty()) {
                Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::Copy(
                    env, cacheItem_.data.data(), cacheItem_.data.size());
                obj.Set("data", buffer);
            }
        }
        
        deferred_.Resolve(obj);
    }
    
    void OnError(const Napi::Error& e) {
        deferred_.Reject(e.Value());
    }

private:
    std::string filePath_;
    int maxSize_;
    bool backgroundDecode_;
    CacheItem cacheItem_;
    bool fromCache_ = false;
    bool embeddedJpegUsed_ = false;
    bool needsBackgroundDecode_ = false;
    std::string error_;
    Napi::Promise::Deferred deferred_;
};

Napi::Value GetWICPreview(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected file path").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    int maxSize = 2000;
    bool backgroundDecode = false;
    
    if (info.Length() > 1 && info[1].IsNumber()) {
        maxSize = info[1].As<Napi::Number>().Int32Value();
    }
    
    if (info.Length() > 2 && info[2].IsBoolean()) {
        backgroundDecode = info[2].As<Napi::Boolean>().Value();
    }
    
    if (!g_wicInitialized) {
        InitWIC();
    }
    
    WICPreviewWorker* worker = new WICPreviewWorker(env, filePath, maxSize, backgroundDecode);
    worker->Queue();
    return worker->GetPromise();
}

Napi::Value DecodeRAWInBackground(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected file path").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    int maxSize = 2000;
    
    if (info.Length() > 1 && info[1].IsNumber()) {
        maxSize = info[1].As<Napi::Number>().Int32Value();
    }
    
    if (!g_wicInitialized) {
        InitWIC();
    }
    
    WICPreviewWorker* worker = new WICPreviewWorker(env, filePath, maxSize, true);
    worker->Queue();
    return worker->GetPromise();
}

class WICThumbnailWorker : public Napi::AsyncWorker {
public:
    WICThumbnailWorker(Napi::Env& env, const std::string& filePath, int maxSize)
        : Napi::AsyncWorker(env),
          filePath_(filePath),
          maxSize_(maxSize),
          deferred_(Napi::Promise::Deferred::New(env)) {}
    
    Napi::Promise GetPromise() { return deferred_.Promise(); }

protected:
    void Execute() {
        if (!g_wicInitialized) {
            if (!InitWIC()) {
                error_ = "WIC not initialized";
                return;
            }
        }
        
        std::wstring widePath = Utf8ToWide(filePath_);
        
        IWICBitmapDecoder* pDecoder = nullptr;
        IWICBitmapFrameDecode* pFrame = nullptr;
        IWICBitmap* pBitmap = nullptr;
        
        HRESULT hr = g_pWICFactory->CreateDecoderFromFilename(
            widePath.c_str(),
            nullptr,
            GENERIC_READ,
            WICDecodeMetadataCacheOnDemand,
            &pDecoder
        );
        
        if (FAILED(hr)) {
            error_ = "Failed to create decoder";
            return;
        }
        
        hr = pDecoder->GetFrame(0, &pFrame);
        if (FAILED(hr)) {
            pDecoder->Release();
            error_ = "Failed to get frame";
            return;
        }
        
        UINT width, height;
        pFrame->GetSize(&width, &height);
        
        if (maxSize_ > 0 && (width > (UINT)maxSize_ || height > (UINT)maxSize_)) {
            IWICBitmapScaler* pScaler = nullptr;
            hr = g_pWICFactory->CreateBitmapScaler(&pScaler);
            if (SUCCEEDED(hr)) {
                double scaleW = (double)maxSize_ / width;
                double scaleH = (double)maxSize_ / height;
                double scale = scaleW < scaleH ? scaleW : scaleH;
                UINT newWidth = (UINT)(width * scale);
                UINT newHeight = (UINT)(height * scale);
                
                hr = pScaler->Initialize(pFrame, newWidth, newHeight, WICBitmapInterpolationModeHighQualityCubic);
                if (SUCCEEDED(hr)) {
                    hr = g_pWICFactory->CreateBitmapFromSource(pScaler, WICBitmapCacheOnDemand, &pBitmap);
                    width_ = newWidth;
                    height_ = newHeight;
                }
                pScaler->Release();
            }
        } else {
            hr = g_pWICFactory->CreateBitmapFromSource(pFrame, WICBitmapCacheOnDemand, &pBitmap);
            width_ = width;
            height_ = height;
        }
        
        pFrame->Release();
        pDecoder->Release();
        
        if (!pBitmap) {
            error_ = "Failed to create bitmap";
            return;
        }
        
        if (!EncodeBitmapToJPEG(pBitmap, data_)) {
            error_ = "Failed to encode JPEG";
        }
        
        pBitmap->Release();
    }
    
    void OnOK() {
        Napi::Env env = Env();
        Napi::Object obj = Napi::Object::New(env);
        
        if (!error_.empty()) {
            obj.Set("success", Napi::Boolean::New(env, false));
            obj.Set("error", Napi::String::New(env, error_));
        } else {
            obj.Set("success", Napi::Boolean::New(env, true));
            obj.Set("width", Napi::Number::New(env, width_));
            obj.Set("height", Napi::Number::New(env, height_));
            
            if (!data_.empty()) {
                Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::Copy(
                    env, data_.data(), data_.size());
                obj.Set("data", buffer);
            }
        }
        
        deferred_.Resolve(obj);
    }
    
    void OnError(const Napi::Error& e) {
        deferred_.Reject(e.Value());
    }

private:
    std::string filePath_;
    int maxSize_;
    std::vector<uint8_t> data_;
    int width_ = 0;
    int height_ = 0;
    std::string error_;
    Napi::Promise::Deferred deferred_;
};

Napi::Value GetWICThumbnail(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected file path").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    int maxSize = 256;
    
    if (info.Length() > 1 && info[1].IsNumber()) {
        maxSize = info[1].As<Napi::Number>().Int32Value();
    }
    
    if (!g_wicInitialized) {
        InitWIC();
    }
    
    WICThumbnailWorker* worker = new WICThumbnailWorker(env, filePath, maxSize);
    worker->Queue();
    return worker->GetPromise();
}

Napi::Value InitWICPreview(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    bool success = InitWIC();
    return Napi::Boolean::New(env, success);
}

Napi::Value UninitWICPreview(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    g_preloadRunning = false;
    g_preloadCV.notify_all();
    if (g_preloadThread.joinable()) {
        g_preloadThread.join();
    }
    
    {
        std::lock_guard<std::mutex> lock(g_cacheMutex);
        g_cache.clear();
        g_lru.clear();
    }
    
    UninitWIC();
    return Napi::Boolean::New(env, true);
}

Napi::Value SetFileList(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[1].IsArray()) {
        Napi::TypeError::New(env, "Expected file list array").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    Napi::Array arr = info[0].As<Napi::Array>();
    std::vector<std::wstring> files;
    
    for (uint32_t i = 0; i < arr.Length(); i++) {
        std::string path = arr.Get(i).As<Napi::String>().Utf8Value();
        files.push_back(Utf8ToWide(path));
    }
    
    {
        std::lock_guard<std::mutex> lock(g_preloadMutex);
        g_fileList = files;
    }
    
    return Napi::Boolean::New(env, true);
}

Napi::Value SetCurrentFile(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected file path").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    
    {
        std::lock_guard<std::mutex> lock(g_preloadMutex);
        g_currentFile = Utf8ToWide(filePath);
    }
    
    g_preloadCV.notify_one();
    
    return Napi::Boolean::New(env, true);
}

Napi::Value StartPreload(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!g_preloadRunning) {
        g_preloadRunning = true;
        g_preloadThread = std::thread(PreloadWorker);
    }
    
    return Napi::Boolean::New(env, true);
}

Napi::Value StopPreload(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    g_preloadRunning = false;
    g_preloadCV.notify_all();
    if (g_preloadThread.joinable()) {
        g_preloadThread.join();
    }
    
    return Napi::Boolean::New(env, true);
}

Napi::Value ClearWICCache(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    std::lock_guard<std::mutex> lock(g_cacheMutex);
    g_cache.clear();
    g_lru.clear();
    
    return Napi::Boolean::New(env, true);
}
