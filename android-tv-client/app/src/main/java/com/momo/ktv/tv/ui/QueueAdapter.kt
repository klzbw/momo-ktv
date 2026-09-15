package com.momo.ktv.tv.ui

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.momo.ktv.tv.R
import com.momo.ktv.tv.data.QueueItem

/**
 * 队列适配器：
 * - 点击项 → 立即播放
 * - 置顶按钮 → 把该项移到队列最前
 * - 删除按钮 → 从队列移除
 * - 播放中项高亮显示
 */
class QueueAdapter(
    private val items: List<QueueItem>,
    private val onItemClick: (QueueItem) -> Unit,
    private val onTopClick: ((QueueItem) -> Unit)? = null,
    private val onRemoveClick: ((QueueItem) -> Unit)? = null
) : RecyclerView.Adapter<QueueAdapter.ViewHolder>() {

    class ViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        val tvTitle: TextView = view.findViewById(R.id.tvQueueItemTitle)
        val tvArtist: TextView = view.findViewById(R.id.tvQueueItemArtist)
        val tvStatus: TextView = view.findViewById(R.id.tvQueueItemStatus)
        val btnTop: Button = view.findViewById(R.id.btnQueueTop)
        val btnRemove: Button = view.findViewById(R.id.btnQueueRemove)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_queue, parent, false)
        return ViewHolder(view)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        val item = items[position]
        holder.tvTitle.text = item.displayTitle
        holder.tvArtist.text = item.displayArtist

        holder.tvStatus.text = when {
            item.isPlaying -> "▶ 播放中"
            item.isTopFlag -> "★ 置顶"
            else -> "${position + 1}"
        }
        // 播放中标题高亮
        holder.tvTitle.setTextColor(
            if (item.isPlaying) 0xFFFFD700.toInt() else 0xFFFFFFFF.toInt()
        )

        holder.itemView.setOnClickListener { onItemClick(item) }
        holder.btnTop.setOnClickListener { onTopClick?.invoke(item) }
        holder.btnRemove.setOnClickListener { onRemoveClick?.invoke(item) }

        // 正在播放的项不允许再删除/置顶（避免误操作）
        holder.btnTop.visibility = if (item.isPlaying) View.INVISIBLE else View.VISIBLE
        holder.btnRemove.visibility = if (item.isPlaying) View.INVISIBLE else View.VISIBLE
    }

    override fun getItemCount(): Int = items.size
}
