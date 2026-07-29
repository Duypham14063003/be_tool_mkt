import { Module } from '@nestjs/common';
import { PostImportService } from './post-import.service';
import { PostsController } from './posts.controller';
@Module({ controllers: [PostsController], providers: [PostImportService] })
export class PostsModule {}
