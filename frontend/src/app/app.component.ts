import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';

const API =
  location.hostname === 'localhost'
    ? 'http://localhost:3001'
    : 'https://translator-video.onrender.com';

type Language = 'en' | 'hi';

interface Beat {
  start: number;
  end: number;
  text: string;
}

interface Script {
  summary: string;
  hook: string;
  language: Language;
  beats: Beat[];

  metadata: {
    title: string;
    description: string;
    tags: string[];
  };
}

interface Options {
  language: Language;

  geminiModel: string;

  tone:
    | 'funny'
    | 'curious'
    | 'wholesome';

  voiceStyle:
    | 'viral_funny'
    | 'facts_explainer'
    | 'story_narrator'
    | 'fast_explainer'
    | 'dramatic_reveal'
    | 'clean';

  watermark: string;
  opacity: number;

  captions: boolean;
  cta: boolean;
  originalAudio: boolean;
  coverOriginalCaptions: boolean;

  fit:
    | 'fill'
    | 'contain';

  voiceId: string;

  review: boolean;
}

interface Job {
  id: string;

  scriptRevision?: number;

  hasAnalysis?: boolean;

  status:
    | 'uploading'
    | 'analyzing'
    | 'review'
    | 'regenerating'
    | 'rendering'
    | 'done'
    | 'error';

  step: string;

  percent: number;

  error?: string | null;

  info?: {
    duration: number;
    width: number;
    height: number;
  };

  script?: Script | null;

  videoUrl?: string | null;

  captionsUrl?: string | null;

  metadataUrl?: string | null;
}

interface Voice {
  id: string;

  name: string;

  language: Language;

  locale: string;

  native: boolean;

  gender?: string;
}

interface HealthStatus {
  ok: boolean;

  ffmpeg: boolean;

  geminiConfigured: boolean;

  cartesiaConfigured: boolean;

  geminiModel: string;

  geminiModels: string[];

  defaultVoice: string;

  hindiVoice: string;

  maxDuration: number;

  maxUploadMB: number;
}

interface ApiKeys {
  geminiKey: string;

  cartesiaKey: string;
}

@Component({
  selector: 'app-root',

  standalone: true,

  imports: [
    CommonModule,
    FormsModule
  ],

  templateUrl:
    './app.component.html',

  styleUrl:
    './app.component.css'
})
export class AppComponent
  implements OnInit, OnDestroy {

  file: File | null = null;

  localPreview = '';

  dragging = false;

  busy = false;

  fetchingVoices = false;

  apiError = '';

  toast = '';

  job: Job | null = null;

  health: HealthStatus | null = null;

  voices: Voice[] = [];

  showAdvanced = false;

  showKeys = false;

  timer:
    ReturnType<typeof setInterval> |
    null = null;

  apiKeys: ApiKeys = {
    geminiKey: '',
    cartesiaKey: ''
  };

  options: Options = {
    language: 'en',

    geminiModel:
      'gemini-3.5-flash-lite',

    tone:
      'funny',

    voiceStyle:
      'viral_funny',

    watermark:
      'MyShortsChannel',

    opacity:
      44,

    captions:
      true,

    cta:
      true,

    originalAudio:
      false,

    coverOriginalCaptions:
      false,

    fit:
      'fill',

    voiceId:
      '',

    review:
      false
  };

  get filteredVoices(): Voice[] {
    return this.voices.filter(
      voice =>
        voice.language ===
        this.options.language
    );
  }

  get selectedVoiceValid(): boolean {
    return this.filteredVoices.some(
      voice =>
        voice.id ===
        this.options.voiceId
    );
  }

  get ready(): boolean {
    const health =
      this.health;

    if (!health) {
      return false;
    }

    return (
      health.ffmpeg &&
      health.geminiConfigured &&
      health.cartesiaConfigured &&
      this.selectedVoiceValid
    );
  }

  get processing(): boolean {
    const job =
      this.job;

    if (!job) {
      return false;
    }

    return [
      'uploading',
      'analyzing',
      'regenerating',
      'rendering'
    ].includes(
      job.status
    );
  }

  get canRegenerate(): boolean {
    const job =
      this.job;

    if (!job) {
      return false;
    }

    return (
      !!job.hasAnalysis &&
      [
        'review',
        'done',
        'error'
      ].includes(
        job.status
      ) &&
      !this.busy &&
      !this.processing &&
      !!this.health?.geminiConfigured
    );
  }

  get backendConnected(): boolean {
    return this.health?.ok ?? false;
  }

  // ======================================
  // VIDEO PREVIEW URL
  // ======================================

  get videoPreviewUrl(): string {
    return this.job?.videoUrl
      ? API + this.job.videoUrl
      : '';
  }

  // ======================================
  // VIDEO DOWNLOAD URL
  // ======================================

  get downloadUrl(): string {
    return this.job?.videoUrl
      ? `${API}${this.job.videoUrl}?download=1`
      : '';
  }

  // ======================================
  // DOWNLOAD FILE NAME
  // ======================================

  get downloadFilename(): string {
    const title =
      this.job?.script?.metadata?.title ||
      'clipcraft-video';

    const safe =
      title
        .replace(
          /[\x00-\x1f<>:"/\\|?*]+/g,
          ' '
        )
        .replace(
          /\s+/g,
          ' '
        )
        .trim()
        .slice(
          0,
          90
        );

    return `${
      safe || 'clipcraft-video'
    }.mp4`;
  }

  // ======================================
  // INIT
  // ======================================

  ngOnInit(): void {
    this.loadSavedKeys();

    void this.checkHealth();
  }

  ngOnDestroy(): void {
    this.stopPolling();

    if (this.localPreview) {
      URL.revokeObjectURL(
        this.localPreview
      );
    }
  }

  // ======================================
  // HEALTH
  // ======================================

  async checkHealth():
    Promise<void> {

    try {
      const response =
        await fetch(
          `${API}/api/health`,
          {
            headers:
              this.authHeaders()
          }
        );

      if (!response.ok) {
        throw new Error(
          'Backend returned an error'
        );
      }

      const healthData =
        (
          await response.json()
        ) as HealthStatus;

      this.health =
        healthData;

      if (
        healthData.geminiModels?.length &&
        !healthData.geminiModels.includes(
          this.options.geminiModel
        )
      ) {
        this.options.geminiModel =
          healthData.geminiModel;
      }

      this.apiError = '';

      if (
        healthData.cartesiaConfigured
      ) {
        await this.loadVoices();
      }

    } catch (error) {
      this.health = null;

      this.apiError =
        `Backend unavailable: ${
          this.errorText(error)
        }`;
    }
  }

  // ======================================
  // CARTESIA VOICES
  // ======================================

  async loadVoices():
    Promise<void> {

    this.fetchingVoices =
      true;

    try {
      const response =
        await fetch(
          `${API}/api/voices`,
          {
            cache:
              'no-store',

            headers:
              this.authHeaders()
          }
        );

      const payload =
        await response.json();

      if (!response.ok) {
        throw new Error(
          payload.error ||
          'Could not load voices'
        );
      }

      const results: Voice[] =
        Array.isArray(
          payload.voices
        )
          ? payload.voices
          : [];

      this.voices =
        results.filter(
          voice =>
            !!voice.id &&
            (
              voice.language === 'hi' ||
              voice.language === 'en'
            )
        );

      if (
        !this.selectedVoiceValid
      ) {
        this.options.voiceId =
          this.filteredVoices[0]?.id ||
          '';
      }

      if (
        !this.filteredVoices.length
      ) {
        this.notify(
          `No ${
            this.options.language === 'hi'
              ? 'Hindi'
              : 'English'
          }-compatible Cartesia voices found.`
        );
      }

    } catch (error) {
      this.voices =
        [];

      this.options.voiceId =
        '';

      this.apiError =
        this.errorText(error);

    } finally {
      this.fetchingVoices =
        false;
    }
  }

  // ======================================
  // LANGUAGE
  // ======================================

  selectLanguage(
    language: Language
  ): void {

    if (
      this.options.language ===
      language
    ) {
      return;
    }

    this.options.language =
      language;

    this.options.voiceId =
      this.filteredVoices[0]?.id ||
      '';

    if (
      !this.options.voiceId &&
      !this.fetchingVoices
    ) {
      void this.loadVoices();
    }
  }

  // ======================================
  // DRAG / DROP
  // ======================================

  dropped(
    event: DragEvent
  ): void {

    event.preventDefault();

    this.dragging =
      false;

    const file =
      event.dataTransfer
        ?.files
        ?.item(0);

    if (file) {
      this.setFile(file);
    }
  }

  browse(
    event: Event
  ): void {

    const file =
      (
        event.target as
        HTMLInputElement
      )
        .files
        ?.item(0);

    if (file) {
      this.setFile(file);
    }
  }

  // ======================================
  // FILE
  // ======================================

  setFile(
    file: File
  ): void {

    if (
      !/\.(mp4|mov|webm|mkv)$/i
        .test(file.name)
    ) {
      this.notify(
        'Upload MP4, MOV, WebM or MKV'
      );

      return;
    }

    const health =
      this.health;

    if (
      health &&
      file.size >
        health.maxUploadMB *
        1048576
    ) {
      this.notify(
        `Maximum upload is ${
          health.maxUploadMB
        } MB`
      );

      return;
    }

    if (
      this.localPreview
    ) {
      URL.revokeObjectURL(
        this.localPreview
      );
    }

    this.file =
      file;

    this.localPreview =
      URL.createObjectURL(
        file
      );

    this.job =
      null;

    this.toast =
      '';

    this.stopPolling();
  }

  // ======================================
  // CREATE
  // ======================================

  async create(
    review: boolean
  ): Promise<void> {

    const file =
      this.file;

    if (
      !file ||
      this.busy ||
      !this.ready
    ) {
      return;
    }

    this.options.review =
      review;

    this.busy =
      true;

    this.apiError =
      '';

    this.job =
      null;

    try {
      const name =
        file.name
          .toLowerCase();

      const mime =
        name.endsWith('.mov')
          ? 'video/quicktime'

          : name.endsWith('.mkv')
            ? 'video/x-matroska'

            : name.endsWith('.webm')
              ? 'video/webm'

              : 'video/mp4';

      const raw =
        new TextEncoder()
          .encode(
            JSON.stringify(
              this.options
            )
          );

      let binary =
        '';

      for (
        const number of raw
      ) {
        binary +=
          String.fromCharCode(
            number
          );
      }

      const encoded =
        btoa(binary)
          .replace(
            /\+/g,
            '-'
          )
          .replace(
            /\//g,
            '_'
          )
          .replace(
            /=/g,
            ''
          );

      const response =
        await fetch(
          `${API}/api/jobs`,
          {
            method:
              'POST',

            headers: {
              'Content-Type':
                mime,

              'X-Options':
                encoded,

              ...this.authHeaders()
            },

            body:
              file
          }
        );

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
          'Upload failed'
        );
      }

      this.job =
        data as Job;

      this.startPolling();

    } catch (error) {
      this.apiError =
        this.errorText(error);

    } finally {
      this.busy =
        false;
    }
  }

  // ======================================
  // POLLING
  // ======================================

  private startPolling():
    void {

    this.stopPolling();

    this.timer =
      setInterval(
        () => {
          void this.poll();
        },
        1300
      );

    void this.poll();
  }

  private stopPolling():
    void {

    if (this.timer) {
      clearInterval(
        this.timer
      );

      this.timer =
        null;
    }
  }

  private async poll():
    Promise<void> {

    const job =
      this.job;

    if (!job) {
      return;
    }

    try {
      const response =
        await fetch(
          `${API}/api/jobs/${job.id}`,
          {
            cache:
              'no-store'
          }
        );

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
          'Polling failed'
        );
      }

      const updatedJob =
        data as Job;

      this.job =
        updatedJob;

      if (
        [
          'done',
          'review',
          'error'
        ].includes(
          updatedJob.status
        )
      ) {
        this.stopPolling();
      }

    } catch (error) {
      this.stopPolling();

      this.apiError =
        this.errorText(error);
    }
  }

  // ======================================
  // REGENERATE SCRIPT
  // ======================================

  async regenerateScript():
    Promise<void> {

    const job =
      this.job;

    if (
      !job ||
      !this.canRegenerate
    ) {
      return;
    }

    this.busy =
      true;

    this.apiError =
      '';

    try {
      const response =
        await fetch(
          `${API}/api/jobs/${job.id}/regenerate`,
          {
            method:
              'POST',

            headers: {
              'Content-Type':
                'application/json',

              ...this.authHeaders()
            },

            body:
              JSON.stringify({
                options:
                  this.options
              })
          }
        );

      const payload =
        await response.json();

      if (!response.ok) {
        throw new Error(
          payload.error ||
          'Script regeneration failed'
        );
      }

      this.job =
        payload as Job;

      this.notify(
        'Creating a fresh story using the same video…'
      );

      this.startPolling();

    } catch (error) {
      this.apiError =
        this.errorText(error);

    } finally {
      this.busy =
        false;
    }
  }

  // ======================================
  // RENDER
  // ======================================

  async renderEdits():
    Promise<void> {

    const job =
      this.job;

    if (
      !job?.script ||
      this.processing ||
      !this.selectedVoiceValid
    ) {
      return;
    }

    this.apiError =
      '';

    this.busy =
      true;

    try {
      const response =
        await fetch(
          `${API}/api/jobs/${job.id}/render`,
          {
            method:
              'POST',

            headers: {
              'Content-Type':
                'application/json',

              ...this.authHeaders()
            },

            body:
              JSON.stringify({
                script:
                  job.script,

                options:
                  this.options
              })
          }
        );

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
          'Render failed'
        );
      }

      this.job =
        data as Job;

      this.startPolling();

    } catch (error) {
      this.apiError =
        this.errorText(error);

    } finally {
      this.busy =
        false;
    }
  }

  // ======================================
  // COPY
  // ======================================

  async copy(
    value: string,
    what: string
  ): Promise<void> {

    try {
      await navigator.clipboard
        .writeText(
          value
        );

      this.notify(
        `${what} copied!`
      );

    } catch {
      this.notify(
        'Clipboard requires HTTPS or localhost'
      );
    }
  }

  // ======================================
  // API KEYS
  // ======================================

  private loadSavedKeys():
    void {

    try {
      const saved =
        JSON.parse(
          localStorage.getItem(
            'clipcraft.apiKeys'
          ) || '{}'
        ) as Partial<ApiKeys>;

      this.apiKeys = {
        geminiKey:
          String(
            saved.geminiKey ||
            ''
          ),

        cartesiaKey:
          String(
            saved.cartesiaKey ||
            ''
          )
      };

    } catch {
      this.apiKeys = {
        geminiKey: '',
        cartesiaKey: ''
      };
    }
  }

  saveKeys():
    void {

    localStorage.setItem(
      'clipcraft.apiKeys',
      JSON.stringify(
        this.apiKeys
      )
    );

    this.notify(
      'API keys saved in this browser'
    );

    void this.checkHealth();
  }

  clearKeys():
    void {

    this.apiKeys = {
      geminiKey: '',
      cartesiaKey: ''
    };

    localStorage.removeItem(
      'clipcraft.apiKeys'
    );

    this.voices =
      [];

    this.options.voiceId =
      '';

    this.notify(
      'Saved browser keys cleared'
    );

    void this.checkHealth();
  }

  private authHeaders():
    Record<string, string> {

    const geminiKey =
      this.apiKeys.geminiKey
        .trim();

    const cartesiaKey =
      this.apiKeys.cartesiaKey
        .trim();

    if (
      !geminiKey &&
      !cartesiaKey
    ) {
      return {};
    }

    const raw =
      new TextEncoder()
        .encode(
          JSON.stringify({
            geminiKey,
            cartesiaKey
          })
        );

    let binary =
      '';

    for (
      const number of raw
    ) {
      binary +=
        String.fromCharCode(
          number
        );
    }

    return {
      'X-Client-Keys':
        btoa(binary)
          .replace(
            /\+/g,
            '-'
          )
          .replace(
            /\//g,
            '_'
          )
          .replace(
            /=/g,
            ''
          )
    };
  }

  // ======================================
  // TAGS
  // ======================================

  get tags():
    string {

    return this.job
      ?.script
      ?.metadata
      .tags
      .join(', ') ||
      '';
  }

  set tags(
    value: string
  ) {
    if (
      this.job?.script
    ) {
      this.job.script
        .metadata
        .tags =
          value
            .split(',')
            .map(
              item =>
                item.trim()
            )
            .filter(
              Boolean
            )
            .slice(
              0,
              15
            );
    }
  }

  // ======================================
  // FULL SCRIPT
  // ======================================

  get fullScript():
    string {

    return this.job
      ?.script
      ?.beats
      .map(
        beat =>
          beat.text
      )
      .join(' ') ||
      '';
  }

  // ======================================
  // HELPERS
  // ======================================

  errorText(
    error: unknown
  ): string {

    return error
      instanceof Error
        ? error.message
        : String(error);
  }

  notify(
    message: string
  ): void {

    this.toast =
      message;
  }

  API_LINK(
    path:
      string |
      null |
      undefined
  ): string {

    return path
      ? API + path
      : '#';
  }

  bytes(
    value: number
  ): string {

    return `${
      (
        value /
        1048576
      ).toFixed(1)
    } MB`;
  }

  seconds(
    time: number
  ): string {

    const seconds =
      Math.round(
        time || 0
      );

    return `${
      Math.floor(
        seconds / 60
      )
    }:${
      String(
        seconds % 60
      ).padStart(
        2,
        '0'
      )
    }`;
  }
}