package com.momo.ktv.tv.lyrics

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.View
import kotlin.math.max

/**
 * 歌词同步显示视图。
 * 支持 LRC 格式歌词（[mm:ss.xx]歌词），根据播放进度高亮当前行。
 * 双行显示：当前行大字居中，上一行/下一行小字辅助。
 */
class LyricsView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    data class LyricLine(
        val timeMs: Long,
        val text: String
    )

    private var lyrics: List<LyricLine> = emptyList()
    private var currentIndex = -1
    private var currentTimeMs: Long = 0

    private val paintCurrent = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#FFD700")
        textSize = 48f
        typeface = Typeface.DEFAULT_BOLD
        textAlign = Paint.Align.CENTER
        setShadowLayer(4f, 2f, 2f, Color.BLACK)
    }

    private val paintOther = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#CCFFFFFF")
        textSize = 32f
        typeface = Typeface.DEFAULT
        textAlign = Paint.Align.CENTER
        setShadowLayer(3f, 1f, 1f, Color.BLACK)
    }

    fun setLyrics(lrcText: String) {
        lyrics = parseLRC(lrcText)
        currentIndex = -1
        invalidate()
    }

    fun setLyricsLines(lines: List<LyricLine>) {
        lyrics = lines.sortedBy { it.timeMs }
        currentIndex = -1
        invalidate()
    }

    fun updateProgress(timeMs: Long) {
        currentTimeMs = timeMs
        val newIndex = findCurrentLine(timeMs)
        if (newIndex != currentIndex) {
            currentIndex = newIndex
            invalidate()
        }
    }

    fun clear() {
        lyrics = emptyList()
        currentIndex = -1
        invalidate()
    }

    private fun parseLRC(text: String): List<LyricLine> {
        val result = mutableListOf<LyricLine>()
        val regex = Regex("\\[(\\d{2}):(\\d{2})[.:](\\d{2,3})\\](.*)")
        for (line in text.lines()) {
            val matches = regex.findAll(line)
            for (match in matches) {
                val min = match.groupValues[1].toIntOrNull() ?: 0
                val sec = match.groupValues[2].toIntOrNull() ?: 0
                val msStr = match.groupValues[3]
                val ms = if (msStr.length == 2) msStr.toInt() * 10 else msStr.toIntOrNull() ?: 0
                val content = match.groupValues[4].trim()
                if (content.isNotEmpty()) {
                    result.add(LyricLine((min * 60 + sec) * 1000L + ms, content))
                }
            }
        }
        return result.sortedBy { it.timeMs }
    }

    private fun findCurrentLine(timeMs: Long): Int {
        if (lyrics.isEmpty()) return -1
        var idx = -1
        for (i in lyrics.indices) {
            if (lyrics[i].timeMs <= timeMs) {
                idx = i
            } else {
                break
            }
        }
        return idx
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (lyrics.isEmpty()) {
            canvas.drawText("暂无歌词", width / 2f, height / 2f, paintOther)
            return
        }

        val centerY = height / 2f
        val lineHeight = paintCurrent.textSize + 20

        // 上一行
        if (currentIndex > 0) {
            canvas.drawText(
                lyrics[currentIndex - 1].text,
                width / 2f,
                centerY - lineHeight,
                paintOther
            )
        }

        // 当前行
        if (currentIndex >= 0 && currentIndex < lyrics.size) {
            canvas.drawText(
                lyrics[currentIndex].text,
                width / 2f,
                centerY,
                paintCurrent
            )
        } else {
            canvas.drawText("♪", width / 2f, centerY, paintOther)
        }

        // 下一行
        if (currentIndex >= 0 && currentIndex < lyrics.size - 1) {
            canvas.drawText(
                lyrics[currentIndex + 1].text,
                width / 2f,
                centerY + lineHeight,
                paintOther
            )
        }
    }

    fun getCurrentLyricText(): String {
        return if (currentIndex >= 0 && currentIndex < lyrics.size) {
            lyrics[currentIndex].text
        } else ""
    }
}
