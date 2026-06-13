// wasaploop — native Windows system-audio capture (WASAPI loopback of the default render
// endpoint), the same OS-level API OBS uses for "Desktop Audio". Streams raw PCM to stdout
// so ffmpeg can mix it with the mic entirely natively — no Chromium, immune to UI throttling.
//
// stderr line on start:  WASAPI_FMT rate=<hz> ch=<n> bits=<n> float=<0|1>
// stdout: continuous interleaved PCM at that format (silence written as zeros to keep timing).
//
// Build: cl /EHsc /O2 wasaploop.cpp /Fe:wasaploop.exe ole32.lib

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <stdio.h>
#include <io.h>
#include <fcntl.h>

#define REFTIMES_PER_SEC 10000000

int main() {
    _setmode(_fileno(stdout), _O_BINARY);

    if (FAILED(CoInitializeEx(NULL, COINIT_MULTITHREADED))) return 1;

    IMMDeviceEnumerator* pEnum = NULL;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), NULL, CLSCTX_ALL,
            __uuidof(IMMDeviceEnumerator), (void**)&pEnum))) return 2;

    IMMDevice* pDevice = NULL;
    if (FAILED(pEnum->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice))) return 3;

    IAudioClient* pClient = NULL;
    if (FAILED(pDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, NULL, (void**)&pClient))) return 4;

    WAVEFORMATEX* pwfx = NULL;
    if (FAILED(pClient->GetMixFormat(&pwfx))) return 5;

    int isFloat = 0;
    if (pwfx->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) isFloat = 1;
    else if (pwfx->wFormatTag == WAVE_FORMAT_EXTENSIBLE && pwfx->wBitsPerSample == 32) isFloat = 1;
    fprintf(stderr, "WASAPI_FMT rate=%u ch=%u bits=%u float=%d\n",
        pwfx->nSamplesPerSec, pwfx->nChannels, pwfx->wBitsPerSample, isFloat);
    fflush(stderr);

    // Loopback capture must use the endpoint's mix format.
    if (FAILED(pClient->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
            REFTIMES_PER_SEC, 0, pwfx, NULL))) return 6;

    IAudioCaptureClient* pCapture = NULL;
    if (FAILED(pClient->GetService(__uuidof(IAudioCaptureClient), (void**)&pCapture))) return 7;

    UINT32 bufFrames = 0;
    pClient->GetBufferSize(&bufFrames);
    DWORD sleepMs = (DWORD)(1000.0 * bufFrames / pwfx->nSamplesPerSec / 2.0);
    if (sleepMs < 2) sleepMs = 2;

    const UINT32 frameBytes = pwfx->nChannels * pwfx->wBitsPerSample / 8;

    if (FAILED(pClient->Start())) return 8;

    static BYTE zeros[19200];
    for (;;) {
        Sleep(sleepMs);
        UINT32 packetLen = 0;
        if (FAILED(pCapture->GetNextPacketSize(&packetLen))) break;
        while (packetLen != 0) {
            BYTE* pData = NULL;
            UINT32 numFrames = 0;
            DWORD flags = 0;
            if (FAILED(pCapture->GetBuffer(&pData, &numFrames, &flags, NULL, NULL))) { packetLen = 0; break; }
            UINT32 bytes = numFrames * frameBytes;
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                UINT32 rem = bytes;
                while (rem > 0) { UINT32 c = rem < sizeof(zeros) ? rem : sizeof(zeros); fwrite(zeros, 1, c, stdout); rem -= c; }
            } else {
                fwrite(pData, 1, bytes, stdout);
            }
            pCapture->ReleaseBuffer(numFrames);
            if (FAILED(pCapture->GetNextPacketSize(&packetLen))) { packetLen = 0; break; }
        }
        fflush(stdout);
    }
    return 0;
}
