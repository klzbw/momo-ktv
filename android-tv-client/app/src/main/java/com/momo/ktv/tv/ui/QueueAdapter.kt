package com.momo.ktv.tv.ui

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.momo.ktv.tv.R
import com.momo.ktv.tv.data.QueueItem

class QueueAdapter(
    private val items: List<QueueItem>,
    private val onItemClick: (QueueItem) -> Unit
) : RecyclerView.Adapter<QueueAdapter.ViewHolder>() {

    class ViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        val tvTitle: TextView = view.findViewById(R.id.tvQueueItemTitle)
        val tvArtist: TextView = view.findViewById(R.id.tvQueueItemArtist)
        val tvStatus: TextView = view.findViewById(R.id.tvQueueItemStatus)
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
        holder.itemView.setOnClickListener { onItemClick(item) }
    }

    override fun getItemCount(): Int = items.size
}
