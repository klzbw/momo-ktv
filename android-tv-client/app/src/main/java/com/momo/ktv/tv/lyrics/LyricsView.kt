package com.momo.ktv.tv.lyrics

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.View
import com.momo.ktv.tv.data.LyricsLine
import kotlin.math.abs
import kotlin.math.min

/**
 * 歌词同步显示视图。
 * - 接收 LRC 字符串或已解析的 LyricsLine 列表
 * - 根据播放进度高亮当前行
 * - 当前行金色大号居中，上一行/下一行半透明白色小字
 * - 无歌词时显示"暂无歌词"
 */
class LyricsView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    private var lyrics: List<LyricsLine> = emptyList()
    private var hasLyricsData: Boolean = false
    private var currentIndex = -1
    private var currentTimeMs: Long = 0

    private val paintCurrent = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#FFD700")
        textSize = 52f
        typeface = Typeface.DEFAULT_BOLD
        textAlign = Paint.Align.CENTER
        isFakeBoldText = true
        setShadowLayer(6f, 2f, 2f, Color.BLACK)
    }

    private val paintAdjacent = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#99FFFFFF")
        textSize = 34f
        typeface = Typeface.DEFAULT
        textAlign = Paint.Align.CENTER
        setShadowLayer(3f, 1f, 1f, Color.BLACK)
    }

    private val paintEmpty = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#88FFFFFF")
        textSize = 30f
        typeface = Typeface.DEFAULT
        textAlign = Paint.Align.CENTER
    }

    /** 直接设置 LRC 文本 */
    fun setLyrics(lrcText: String?) {
        if (lrcText.isNullOrBlank()) {
            lyrics = emptyList()
            hasLyricsData = false
        } else {
            lyrics = LyricsLine.parseLRC(lrcText)
            hasLyricsData = lyrics.isNotEmpty()
        }
        currentIndex = -1
        invalidate()
    }

    /** 直接设置已解析行 */
    fun setLyricsLines(lines: List<LyricsLine>) {
        lyrics = lines.sortedBy { it.timeMs }
        hasLyricsData = lyrics.isNotEmpty()
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
        hasLyricsData = false
        currentIndex = -1
        invalidate()
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
        val cx = width / 2f
        val centerY = height / 2f

        // 无歌词数据：显示"暂无歌词"
        if (!hasLyricsData) {
            canvas.drawText("暂无歌词", cx, centerY, paintEmpty)
            return
        }
        if (lyrics.isEmpty()) {
            canvas.drawText("暂无歌词", cx, centerY, paintEmpty)
            return
        }

        val lineHeight = paintCurrent.textSize + 28f

        // 当前行尚未开始（片头）：显示第一行预览为半透明
        if (currentIndex < 0) {
            canvas.drawText(lyrics[0].text, cx, centerY, paintAdjacent)
            return
        }

        // 上一行
        if (currentIndex > 0) {
            val prev = lyrics[min(currentIndex - 1, lyrics.size - 1)]
            canvas.drawText(prev.text, cx, centerY - lineHeight, paintAdjacent)
        }

        // 当前行（高亮放大）
        val cur = lyrics[currentIndex]
        canvas.drawText(cur.text, cx, centerY, paintCurrent)

        // 下一行
        if (currentIndex < lyrics.size - 1) {
            val next = lyrics[currentIndex + 1]
            canvas.drawText(next.text, cx, centerY + lineHeight, paintAdjacent)
        }
    }

    fun getCurrentLyricText(): String {
        return if (currentIndex >= 0 && currentIndex < lyrics.size) {
            lyrics[currentIndex].text
        } else ""
    }
}
