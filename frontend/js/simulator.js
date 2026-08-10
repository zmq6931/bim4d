/**
 * 4D 模拟引擎
 * 负责：时间轴控制、日期推进、状态计算触发、播放/暂停
 *
 * 暴露到 window.BIMSimulator
 * 依赖：window.BIMViewer, window.BIMGantt, window.BIMApp
 */
(function () {
    "use strict";

    const BIMSimulator = {
        _startDate: null,      // Date 对象
        _endDate: null,
        _totalDays: 0,
        _currentDay: 0,        // 距 start 的天数偏移
        _playing: false,
        _timer: null,
        _speed: 1000,          // 毫秒/天
        _onDateChange: null,   // 外部回调(dateStr)

        /**
         * 初始化时间范围
         * @param {string} startStr - 'YYYY-MM-DD'
         * @param {string} endStr
         */
        setRange(startStr, endStr) {
            if (!startStr || !endStr) return;
            this._startDate = this._parse(startStr);
            this._endDate = this._parse(endStr);
            // 前面多留 10% 的时间（最少 3 天），让模拟从"什么都没有"开始
            const totalMs = this._endDate - this._startDate;
            const padDays = Math.max(3, Math.floor((totalMs / (1000 * 60 * 60 * 24)) * 0.1));
            this._startDate.setDate(this._startDate.getDate() - padDays);
            const ms = this._endDate - this._startDate;
            this._totalDays = Math.max(1, Math.ceil(ms / (1000 * 60 * 60 * 24)));
            this._currentDay = padDays;  // 初始位置 = 第一个任务开始的位置

            const slider = document.getElementById("dateSlider");
            if (slider) {
                slider.min = 0;
                slider.max = this._totalDays;
                slider.value = this._currentDay;
            }
            this._updateDisplay();
        },

        /** 自定义起始日期（不自动加 padding） */
        setCustomStart(startStr) {
            if (!startStr || !this._endDate) return;
            const newStart = this._parse(startStr);
            if (!newStart) return;
            this._startDate = newStart;
            const ms = this._endDate - this._startDate;
            this._totalDays = Math.max(1, Math.ceil(ms / (1000 * 60 * 60 * 24)));
            this._currentDay = Math.max(0, Math.min(this._totalDays, this._currentDay));
            const slider = document.getElementById("dateSlider");
            if (slider) { slider.max = this._totalDays; slider.value = this._currentDay; }
            this._updateDisplay();
        },

        _parse(str) {
            const d = new Date(str + "T00:00:00");
            return isNaN(d) ? null : d;
        },

        /**
         * 获取当前模拟日期字符串
         */
        getCurrentDateStr() {
            if (!this._startDate) return "";
            const d = new Date(this._startDate);
            d.setDate(d.getDate() + this._currentDay);
            return this._fmt(d);
        },

        /** 获取模拟起始日期（滑块 day=0 对应的日期） */
        getStartDateStr() {
            if (!this._startDate) return "";
            return this._fmt(new Date(this._startDate));
        },

        _fmt(d) {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, "0");
            const day = String(d.getDate()).padStart(2, "0");
            return `${y}-${m}-${day}`;
        },

        /**
         * 跳到指定天数偏移
         */
        setDay(day) {
            this._currentDay = Math.max(0, Math.min(this._totalDays, day));
            this._updateDisplay();
            if (this._onDateChange) this._onDateChange(this.getCurrentDateStr());
        },

        /**
         * 跳到指定日期
         */
        setDate(dateStr) {
            if (!this._startDate) return;
            const d = this._parse(dateStr);
            if (!d) return;
            const day = Math.floor((d - this._startDate) / (1000 * 60 * 60 * 24));
            this.setDay(day);
        },

        stepForward() {
            this.setDay(this._currentDay + 1);
        },

        stepBack() {
            this.setDay(this._currentDay - 1);
        },

        play() {
            if (this._playing) return;
            if (!this._startDate) return;
            // 到末尾则从头开始
            if (this._currentDay >= this._totalDays) {
                this._currentDay = 0;
            }
            this._playing = true;
            this._updatePlayBtn();
            this._tick();
        },

        pause() {
            this._playing = false;
            if (this._timer) {
                clearTimeout(this._timer);
                this._timer = null;
            }
            this._updatePlayBtn();
        },

        stop() {
            this.pause();
            this._currentDay = 0;
            this._updateDisplay();
            if (this._onDateChange) this._onDateChange(this.getCurrentDateStr());
        },

        _tick() {
            if (!this._playing) return;
            this.stepForward();
            if (this._currentDay >= this._totalDays) {
                this.pause();
                return;
            }
            this._timer = setTimeout(() => this._tick(), this._speed);
        },

        setSpeed(ms) {
            this._speed = ms;
        },

        _updateDisplay() {
            const slider = document.getElementById("dateSlider");
            if (slider) slider.value = this._currentDay;

            const display = document.getElementById("currentDate");
            if (display) display.textContent = this.getCurrentDateStr() || "未加载";
        },

        _updatePlayBtn() {
            const btn = document.getElementById("btnPlay");
            if (!btn) return;
            if (this._playing) {
                btn.textContent = "⏸";
                btn.classList.add("playing");
            } else {
                btn.textContent = "▶";
                btn.classList.remove("playing");
            }
        },

        onDateChange(callback) {
            this._onDateChange = callback;
        },

        get isReady() {
            return this._startDate !== null;
        },
    };

    window.BIMSimulator = BIMSimulator;
})();
